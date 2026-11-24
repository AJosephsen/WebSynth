#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define KB_SILENT 255u
#define NTRK 4
#define FS 44100u
#define NELEM(a) (sizeof(a)/sizeof((a)[0]))
typedef struct { int32_t p[32]; uint32_t eng_req; uint32_t idx; uint8_t seq_n; uint8_t seq_notes[8]; uint8_t nheld; } track_t;
enum { P_ROOT, P_SCALE, P_QUANT, P_TRANS, P_MPCDEG, P_OCT, P_CHRD, P_VOIC, P_VOICE, P_MUTE, P_STRUM, P_STROKE, P_AMODE };
enum { Q_OFF, Q_SNAP, Q_WHITE, Q_ALL, Q_MPC };
enum { V_POLY, V_MONO, V_LEGATO, V_UNISON };
static track_t trk[NTRK];
static uint32_t live_held[NTRK][4];
static uint8_t track_solo;
static int32_t clamp(int32_t v, int32_t lo, int32_t hi){ return v<lo?lo:v>hi?hi:v; }
typedef struct engine_s { int oneshot; int (*keys)(const track_t*, uint32_t); } engine_t;
static const engine_t E0 = {0, 0}, E1 = {1, 0}; static const engine_t *ENGINES[] = {&E0, &E1};
static uint32_t eng_idx(uint32_t x){ return x & 1u; }
static int32_t input_octave(const track_t *t){ return t->p[P_OCT]; }
static uint32_t trk_index(const track_t *t){ return t->idx; }
static uint32_t trk_vmode(const track_t *t){ return (uint32_t)t->p[P_VOICE]; }
static uint32_t trk_n(void){ return NTRK; }
static int drum_track(const track_t *t){ (void)t; return 0; }
static uint32_t drum_mpc_note(const track_t *t, uint32_t pad){ (void)t; return pad; }
static uint32_t beat_var = 22050u;
static uint32_t beat_samples(void){ return beat_var; }
static uint32_t seq_beat_samples(void){ return beat_var; }
static const char *const N_NOTE[] = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};
static const char *const N_STRUM[] = {"OFF", "1/8", "1/16", "1/32", "1/64", "1/128", "16T", "32T"};
static uint32_t str_len(const char *s){ return (uint32_t)strlen(s); }
static void str_cpy(char *d, const char *s, uint32_t n){ strncpy(d, s, n); d[n-1]=0; }
#include "microtonal.h"
static uint32_t scale_mask(const track_t *t)
{
    const micro_scale_t *s = micro_scale(t);
    if (s) { /* approximate pitch classes for the keyboard LEDs only */
        uint32_t mask = 0;
        for (uint32_t i = 0; i < s->count; i++)
            mask |= 1u << ((s->pitch[i] + 5000) / 10000 % 12);
        return mask;
    }
    return SCALE_MASK[clamp(t->p[P_SCALE], 0, SCALE_LEGACY - 1)];
}

static uint32_t scale_count(const track_t *t)
{
    if (micro_scale(t)) return micro_scale(t)->count;
    uint32_t mask = scale_mask(t), count = 0;
    while (mask) {
        count += mask & 1u;
        mask >>= 1;
    }
    return count;
}

static int32_t mpc_degree(const track_t *t) { return clamp(t->p[P_MPCDEG], 1, (int32_t)scale_count(t)); }

/* scale degree `degree` from C4 (0 = the ROOT above C4) in the track's scale, + offset semitones and TRN. strict: a
 * note off the MIDI range is silent (else clamped). Scales of 5, 6, 8 or 12 notes repeat no degree */
static uint32_t scale_degree_map(const track_t *t, int32_t degree, int32_t offset, int strict)
{
    if (micro_active(t)) return micro_degree_map(t, degree, offset, strict);
    uint32_t mask = scale_mask(t), i;
    int32_t count = (int32_t)scale_count(t), oct, n;
    oct = degree / count;
    degree %= count;
    if (degree < 0) {
        degree += count;
        oct--;
    }
    for (i = 0; i < 12u; i++)
        if ((mask >> i) & 1u) {
            if (!degree)
                break;
            degree--;
        }
    n = 60 + t->p[P_ROOT] + 12 * oct + (int32_t)i + offset + t->p[P_TRANS];
    if (strict && (n < 0 || n > 127))
        return KB_SILENT;
    return (uint32_t)clamp(n, 0, 127);
}

/* note n (a key's or a MIDI note) through the WHITE / ALL layouts. WHITE (and MPC on the keys): the white keys walk
 * the scale from C4 = ROOT, the black keys are silent. ALL: every key the next degree of the scale */
static uint32_t scale_map(const track_t *t, int32_t n, int32_t offset)
{
    static const int8_t DEGREE[12] = {0, -1, 1, -1, 2, 3, -1, 4, -1, 5, -1, 6};
    int32_t degree;
    if (t->p[P_QUANT] == Q_ALL)
        return scale_degree_map(t, n - 60, offset, 1);
    if (t->p[P_QUANT] == Q_WHITE || t->p[P_QUANT] == Q_MPC) {
        if ((degree = DEGREE[n % 12]) < 0)
            return KB_SILENT;
        return scale_degree_map(t, degree + (n / 12 - 5) * 7, offset, 0);
    }
    return (uint32_t)clamp(n + offset + t->p[P_TRANS], 0, 127);
}

static uint32_t kb_map(const track_t *t, uint32_t k)
{
    const engine_t *e = ENGINES[eng_idx(t->eng_req)];   /* (the engine it switches to) */
    int32_t n;
    if (e->keys && (n = e->keys(t, k)) >= 0)           /* the engine's own key map (GM kit, slices) */
        return (uint32_t)n;
    n = 53 + (int32_t)k;
    if (t->p[P_QUANT] == Q_SNAP) {                     /* SNAP: every key, rounded down to the scale */
        if (micro_active(t)) {
            uint32_t note = micro_snap(t, n + t->p[P_TRANS]);
            return note == KB_SILENT ? note : micro_degree_map(t, (int32_t)note - 60, 12 * input_octave(t), 1);
        }
        uint32_t mask = scale_mask(t), guard = 12;
        n += 12 * input_octave(t) + t->p[P_TRANS];
        while (guard-- && !((mask >> (uint32_t)((n - t->p[P_ROOT] + 120) % 12)) & 1u))
            n--;
        return (uint32_t)clamp(n, 0, 127);
    }
    return scale_map(t, n, 12 * input_octave(t));
}

/* MPC Sample blank.xpj, data.tracks[0].program.padNoteMap.noteForPad: E01 = 100, F01 = 116
 * (F13 wraps to 0), G01 = 4, H01 = 20. Return E01..H16 as 0..63; A..D are 64..127. */
static uint32_t mpc_pad(uint32_t note) { return (note + 28u) & 127u; }

/* A MIDI note into track t: WHITE and ALL map it as the keys (without the octave buttons).
 * MPC banks E..H play tracks 1..4, each pad 02 on DEG. Other banks / tracks are silent, kits too.
 * DRUM uses its finger-drumming layout; other kits and slices keep their own note map. KB_SILENT: none. */
static uint32_t midi_map(const track_t *t, uint32_t note)
{
    const engine_t *e = ENGINES[eng_idx(t->eng_req)];
    uint32_t pad = mpc_pad(note);
    if (t->p[P_QUANT] == Q_MPC && pad / 16u != trk_index(t))
        return KB_SILENT;
    if (t->p[P_QUANT] == Q_MPC && drum_track(t))
        return drum_mpc_note(t, pad);
    if (e->keys && e->keys(t, 0) >= 0)
        return note;
    if (t->p[P_QUANT] == Q_MPC)
        return scale_degree_map(t, (int32_t)(pad & 15u) - 1 + mpc_degree(t) - 1, 12 * input_octave(t), 1);
    if (t->p[P_QUANT] == Q_WHITE || t->p[P_QUANT] == Q_ALL)
        return scale_map(t, (int32_t)note, 0);
    if (micro_active(t) && t->p[P_QUANT] == Q_SNAP)
        return micro_snap(t, (int32_t)note + t->p[P_TRANS]);
    return note;
}


#include "chord.c"

static uint32_t rs = 12345u;
static uint32_t rnd32(void){ rs = rs * 1664525u + 1013904223u; return rs; }
static uint32_t rnd(uint32_t n){ return (rnd32() >> 8) % n; }
static uint32_t H = 2166136261u;
static void fnv(uint32_t v){ for (int i = 0; i < 4; i++) { H ^= (v >> (8*i)) & 255u; H *= 16777619u; } }
static void configure(uint32_t k){
  track_t *t = &trk[k]; t->idx = k;
  t->p[P_CHRD] = (int32_t)rnd(12); t->p[P_VOIC] = (int32_t)rnd(5);
  t->p[P_SCALE] = rnd(10) < 8 ? (int32_t)rnd(16) : (int32_t)(16 + rnd(54));
  t->p[P_QUANT] = (int32_t)rnd(5); t->p[P_ROOT] = (int32_t)rnd(12); t->p[P_TRANS] = (int32_t)rnd(9) - 4;
  t->p[P_VOICE] = rnd(6) == 0 ? (int32_t)rnd(4) : 0; t->eng_req = rnd(10) == 0 ? 1u : 0u; t->p[P_MUTE] = rnd(8) == 0;
  t->p[P_OCT] = (int32_t)rnd(3) - 1; t->p[P_MPCDEG] = 1;
  t->p[P_STRUM] = (int32_t)rnd(9); t->p[P_STROKE] = (int32_t)rnd(3); t->p[P_AMODE] = rnd(6) == 0;
}
static void hashname(uint32_t mode, uint32_t root, uint32_t mask){
  char b[12]; memset(b, 0, sizeof b);
  if (mode == CH_AUTO) chord_auto_name(b, root, mask); else if (mode == CH_MELODY) chord_melody_name(b, root, mask); else chord_name(b, root, mask);
  for (int i = 0; i < 12 && b[i]; i++) fnv((uint32_t)b[i]);
}
int main(void){
  for (uint32_t k = 0; k < NTRK; k++) configure(k);
  int builds = 0;
  for (int step = 0; step < 6000; step++) {
    uint32_t op = rnd(10), k = rnd(NTRK);
    if (op == 0 || op == 1) chord_auto_tick(rnd(30000));
    else if (op == 2) chord_auto_observe(&trk[k], rnd(130));
    else if (op == 3) { for (int w = 0; w < 4; w++) live_held[k][w] = rnd(3) == 0 ? rnd32() : 0u; trk[k].nheld = (uint8_t)(rnd(4) == 0 ? rnd(3) : 0); }
    else if (op == 4) { trk[k].seq_n = (uint8_t)rnd(4); for (int i = 0; i < 4; i++) trk[k].seq_notes[i] = (uint8_t)rnd(128); }
    else if (op == 5) { configure(k); if (rnd(3) == 0) chord_auto_forget(k); track_solo = rnd(3) == 0 ? (uint8_t)(1u << rnd(NTRK)) : 0; beat_var = 11025u + rnd(30000); }
    else {
      uint8_t out[8]; uint32_t root = rnd(128); int32_t rp; uint16_t mask; memset(out, 0, sizeof out);
      if (op == 6) { uint32_t m = chord_make(&trk[k], root, out, &rp, &mask); fnv(m); fnv((uint32_t)rp); fnv(mask); for (uint32_t i = 0; i < m; i++) fnv(out[i]); hashname((uint32_t)trk[k].p[P_CHRD], (uint32_t)rp, mask); }
      else { uint32_t m = chord_build(&trk[k], root, out); fnv(m); for (uint32_t i = 0; i < m; i++) fnv(out[i]); fnv(chord_last[k].root); fnv(chord_last[k].mask); fnv(chord_last[k].gen); hashname((uint32_t)trk[k].p[P_CHRD], chord_last[k].root, chord_last[k].mask); builds++;
      if (op == 9) {
        uint8_t n2[8]; memcpy(n2, out, 8); chord_strum_t st; uint32_t first = chord_strum_begin(&trk[k], n2, m, &st, 100);
        fnv(first); for (uint32_t i = 0; i < m; i++) fnv(n2[i]); fnv(st.total); fnv(st.rate);
        if (st.total) {
          uint32_t started = first, tm = 0;
          while (started < st.total && tm < 200000u) {
            uint32_t chunk = 1u + rnd(3000); if (rnd(7) == 0) beat_var = 11025u + rnd(30000);
            tm += chunk; chord_strum_due(&st, started, chunk);
            while (started < st.total && !chord_strum_due(&st, started, 0)) { fnv(tm); started++; }
          }
          fnv(st.pos); fnv(st.beat);
        }
      }
    }
    }
  }
  printf("builds %d hash %08x\n", builds, H);
  return 0;
}
