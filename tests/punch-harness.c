/* Harness for Melodee's PUNCH-IN FX (punch.c): compiles the real file with stubs and prints, per scenario, running hashes of the
 * processed samples (tests/punch-gold.txt). Build (MEL = Melodee's firmware/src, GEN = a directory with melodee_tables.h from
 * tools/gen_tables.py):
 *   gcc -O1 -fwrapv -w -I$MEL -I$GEN -o punch-harness tests/punch-harness.c -lm && ./punch-harness > tests/punch-gold.txt */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "melodee_tables.h"
#include "tuning.h"
typedef struct { int32_t amp0, amp1; } vmod_t;
#include "dsp.c"
/* fx.c pieces the freeze reverb uses (state, scaling, wet-input tone) */
typedef struct { float b0,b1,b2,a1,a2,z1,z2; } fx_bq_t;
typedef struct {
    fx_bq_t time_tone[2];
    uint16_t comb[4], rev_span[4];
    uint32_t phase, age, epoch, pos;
    int32_t rng, random, mix;
    int16_t rate, character;
    uint8_t type, mono, decim, failed;
    int32_t echo, damp[4];
    int32_t rev_damp[8], rev_l, rev_r, rev_prev_l, rev_prev_r;
    int32_t rev_bass[2];
    int16_t rev_rate, rev_char;
} fx_state_t;
enum { FX_REVERB = 8 };
static volatile uint32_t fx_epoch;
static inline int32_t fx_scale(int32_t a,uint32_t k) {return (a>>16)*(int32_t)k+(int32_t)(((uint32_t)(a&65535)*k)>>16);}
static inline int32_t fx_div_pow2(int32_t x,uint32_t shift) {return (x+(int32_t)(((uint32_t)x>>31)*((1u<<shift)-1u)))>>shift;}
static inline float fx_tone_section(fx_bq_t *q,float x,float slew,uint32_t highpass)
{
    float enabled=q->a2>0?1.0f:0.0f;
    if(!enabled && q->b1<0.000001f){q->b0=q->b1=q->z1=0;return x;}
    q->b0+=(q->a1-q->b0)*slew;q->b1+=(enabled-q->b1)*slew;
    float v=(x-q->z1)*q->b0,low=v+q->z1;q->z1=low+v;
    if(q->z1>-1e-9f && q->z1<1e-9f)q->z1=0;
    return highpass?x-low*q->b1:x+(low-x)*q->b1;
}
static inline int32_t fx_tone_input(fx_state_t *f,int32_t input,float slew)
{
    float x=fx_tone_section(&f->time_tone[0],(float)input,slew,1);
    return (int32_t)fx_tone_section(&f->time_tone[1],x,slew,0);
}
#include "fx_sloop_reverb.h"
/* stubs for the host */
#define RES_PUNCH 0
static struct { uint32_t buttons; } fm1_in;
static struct { int playing; } song;
static uint32_t h_beat = 22050, h_clock;
static uint32_t beat_samples(void) { return h_beat; }
static uint32_t punch_clock_samples(void) { return h_clock; }
static int16_t arena[16384 + 64] __attribute__((aligned(16)));
static int arena_used;
static void *resource_get(int id, uint32_t n) { (void)id; (void)n; memset(arena, 0, sizeof arena); arena_used = 1; return arena; }
static void resource_release(int id) { (void)id; arena_used = 0; }
#include "punch.c"

static uint32_t fnv(uint32_t h, uint32_t v) { for (int k = 0; k < 4; k++) { h ^= (v >> (8 * k)) & 255u; h *= 16777619u; } return h; }
/* the input: a mix of two sines, noise and impulses, a function of the absolute sample only */
static uint32_t rs;
static uint32_t urnd(void) { rs ^= rs << 13; rs ^= rs >> 17; rs ^= rs << 5; return rs >> 17; }
static int amp_shift;
static void signal_at(uint32_t s, int32_t *l, int32_t *r)
{
    uint32_t ph = s;
    int32_t env = ph % 9000 < 4000 ? 4000 - (int32_t)(ph % 9000) : 0;
    int32_t a = sine_i(ph * 97391u) >> 1, b = sine_i(ph * 41011u + 5555u) >> 1;
    int32_t nl = ((int32_t)((ph * 2654435761u) >> 17) - 16384) / 4, nr = ((int32_t)(((ph * 40503u + 7u) * 2246822519u) >> 17) - 16384) / 4;
    int32_t x = ((a + nl) * (env >> 4)) >> 5, y = ((b + nr) * (env >> 4)) >> 5;
    if (ph % 9000 == 0) { x += 12000; y -= 9000; }
    if (ph % 20011 == 0) { x += 90000; y += 70000; }
    *l = (x * 4) << amp_shift; *r = (y * 4) << amp_shift;
}
static uint32_t scen_run(const char *name, uint32_t seed, int mode, int fx0, uint32_t bpm0, int playing0, int pattern, int nblocks, int amp)
{
    /* mode 0: hold fx0 from block 40 to two thirds of the run; mode 1: random events from seed */
    uint32_t h = 2166136261u, sample = 0, nb = 0, blk, nxt = 40;
    int req = -1, keybit = 0, sreq = -1, sbuf = 0, playing = playing0;
    uint32_t bpm = bpm0, sgate = 0, pat_i = 0;
    static const uint8_t PAT[2][8] = {{32, 32, 32, 32, 32, 32, 32, 32}, {32, 7, 32, 1, 16, 32, 31, 5}};
    rs = seed * 2654435761u + 12345u; if (!rs) rs = 1;
    amp_shift = amp;
    memset(&punch, 0, sizeof punch); punch.req = punch.cur = -1; punch_ring = 0; punch_alloc_tried = 0; punch_memory_failed = 0;
    punch_song_req = -1; punch_song_buffered = 0; punch_song_gate = 0; punch_epoch = fx_epoch; arena_used = 0;
    h_clock = 0;
    printf("== %s\n", name);
    for (blk = 0; blk < (uint32_t)nblocks; blk++) {
        if (mode == 0) {
            if (blk == 40) { req = fx0; keybit = 1; }
            if (blk == (uint32_t)nblocks * 2 / 3) { req = -1; keybit = 0; }
        } else if (blk >= nxt) {
            uint32_t c = urnd() % 12u;
            nxt = blk + 1 + urnd() % (c < 3 ? 40u : 260u);
            if (c < 4) { req = (int)(urnd() % 27u); keybit = 1; }
            else if (c < 6) { req = -1; keybit = 0; }
            else if (c == 6) { sreq = (int)(urnd() % 28u) - 1; sbuf = sreq >= 0 && (urnd() & 1u); }
            else if (c == 7) { sgate++; punch_song_gate = sgate; }
            else if (c == 8) { bpm = 50u + urnd() % 150u; }
            else if (c == 9) { playing = !playing; h_clock = urnd() * 3u; }
            else if (c == 10) { sreq = -1; sbuf = 0; }
            else { fx_epoch++; }
        }
        h_beat = FS * 60u / bpm;
        if (h_clock >= h_beat) h_clock %= h_beat;
        song.playing = playing;
        punch.req = (int8_t)req; punch.keybit = keybit ? 1u : 0u;
        punch_song_req = (int8_t)sreq; punch_song_buffered = (uint8_t)sbuf;
        uint32_t n = PAT[pattern][pat_i++ & 7u];
        int32_t l[CTL], r[CTL];
        for (uint32_t i = 0; i < n; i++) signal_at(sample + i, &l[i], &r[i]);
        punch_process(l, r, n);
        if (playing) { h_clock += n; while (h_clock >= h_beat) h_clock -= h_beat; }
        sample += n;
        for (uint32_t i = 0; i < n; i++) { h = fnv(h, (uint32_t)l[i]); h = fnv(h, (uint32_t)r[i]); }
        if (++nb % 64u == 0) printf("%u %08x\n", blk, h);
    }
    printf("end %u %08x g=%d cur=%d\n", blk, h, punch.g, punch.cur);
    return h;
}
int main(void)
{
    static const uint32_t BPMS[4] = {60, 120, 174, 240};
    char name[96];
    uint32_t cfg = 0;
    for (int fx = 0; fx < 27; fx++)
        for (int b = 0; b < 4; b++)
            for (int pl = 0; pl < 2; pl++)
                for (int pat = 0; pat < 2; pat++) {
                    snprintf(name, sizeof name, "fx%d bpm%u play%d pat%d", fx, BPMS[b], pl, pat);
                    scen_run(name, (uint32_t)(fx * 8 + b * 2 + pl) + 1u, 0, fx, BPMS[b], pl, pat, pat ? 1100 : 1500, (fx + b) % 5 == 4 ? 2 : 0);
                    cfg++;
                }
    for (uint32_t s = 0; s < 120; s++) {
        snprintf(name, sizeof name, "random%u", s);
        scen_run(name, 1000u + s, 1, -1, 90u + s, s & 1, (int)(s % 2), 2400, s % 7 == 6 ? 2 : 0);
        cfg++;
    }
    printf("configs %u\n", cfg);
    return 0;
}
