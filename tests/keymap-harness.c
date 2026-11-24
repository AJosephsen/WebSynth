#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define KB_SILENT 255u
typedef struct { int32_t p[32]; uint32_t eng_req; uint32_t idx; } track_t;
enum { P_ROOT, P_SCALE, P_QUANT, P_TRANS, P_MPCDEG, P_OCT };
enum { Q_OFF, Q_SNAP, Q_WHITE, Q_ALL, Q_MPC };
static int32_t clamp(int32_t v, int32_t lo, int32_t hi){ return v<lo?lo:v>hi?hi:v; }
typedef struct engine_s { int (*keys)(const track_t*, uint32_t); } engine_t;
static const engine_t E0 = {0}; static const engine_t *ENGINES[] = {&E0};
static uint32_t eng_idx(uint32_t x){ (void)x; return 0; }
static int32_t input_octave(const track_t *t){ return t->p[P_OCT]; }
static uint32_t trk_index(const track_t *t){ return t->idx; }
static int drum_track(const track_t *t){ (void)t; return 0; }
static uint32_t drum_mpc_note(const track_t *t, uint32_t pad){ (void)t; return pad; }
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


static uint32_t fnv(uint32_t h, uint32_t v){ h ^= v & 255u; h *= 16777619u; h ^= (v>>8)&255u; h *= 16777619u; return h; }
int main(void){
  uint32_t h = 2166136261u; track_t t; memset(&t,0,sizeof t); t.eng_req = 3;
  int n=0;
  for (int scale=0; scale<70; scale++)
   for (int quant=0; quant<5; quant++)
    for (int root=0; root<12; root+=5)
     for (int trans=-7; trans<=7; trans+=7)
      for (int oct=-1; oct<=1; oct++)
       for (int mpc=1; mpc<=3; mpc+=2) {
        t.p[P_SCALE]=scale; t.p[P_QUANT]=quant; t.p[P_ROOT]=root; t.p[P_TRANS]=trans; t.p[P_OCT]=oct; t.p[P_MPCDEG]=mpc; t.idx=(root+oct+1)&3;
        for (uint32_t k=0;k<27;k++) h = fnv(h, kb_map(&t,k));
        for (uint32_t m=0;m<128;m+=3) h = fnv(h, midi_map(&t,m));
        if (micro_scale(&t)) { for (int32_t note=0; note<128; note+=7) h = fnv(h, (uint32_t)micro_pitch(&t,note)), h = fnv(h, (uint32_t)(micro_pitch(&t,note)>>16)); }
        h = fnv(h, scale_mask(&t)); h = fnv(h, scale_count(&t)); h=fnv(h, scale_note_period(&t)); h=fnv(h, micro_active(&t));
        n++;
       }
  printf("%d configs, hash %08x\n", n, h);
  return 0;
}
