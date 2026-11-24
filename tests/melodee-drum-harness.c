/* Reference renders of Melodee's new drum kits (KIT 808, 909, CR78, FM): the real firmware sources, driven through
 * the part's own note path (trk_note_on -> eng_drum.c -> voice.c track_render), on the host simulator of Melodee.
 *
 * Build (M = a Melodee checkout, GPL-3.0-only, Kerem Kilic):
 *   cd $M && mkdir -p build/gen && for g in "gen_tables.py melodee_tables.h" "gen_fm6_patches.py melodee_fm6.h" \
 *     "gen_cz1_factory.py melodee_cz1.h" "gen_909_tables.py x0x_drum_tables.h" "gen_ui_palettes.py ui_palettes.h" \
 *     "gen_icons.py ui_icons.h" "gen_aa_keycaps.py ui_keycaps.h"; do set -- $g; python3 tools/$1 build/gen/$2; done
 *   python3 tools/gen_prophet_factory.py build/gen/melodee_prophet_factory.h --web check
 *   cc -O2 -ffp-contract=off -w -I$M/build/gen -I$M/firmware/src -I$M/tests -o harness tests/melodee-drum-harness.c -lm
 *   ./harness > tests/melodee-drum-gold.txt
 * (-ffp-contract=off: the device has no fused multiply-add; the 909 and the kits' setups are float.)
 * Every case is rendered block by block (CTL = 32 samples); the 64-bit FNV-1a of every output sample, and the peak. */
#define main hostsim_main
#include "hostsim.c"
#undef main

static uint32_t rs;
static uint32_t rnd(void) { rs = rs * 1664525u + 1013904223u; return rs >> 8; }
static uint32_t rn(uint32_t n) { return rnd() % n; }

static uint64_t H;
static int32_t PEAK;
static void hfnv(uint32_t x)
{
    for (int k = 0; k < 4; k++) { H ^= (x >> (8 * k)) & 255u; H *= 1099511628211ull; }
}

typedef struct { uint16_t block; uint8_t note, vel; int16_t pitch; uint16_t len; } ev_t;
static const uint8_t PRESET[4] = {0, 1, 4, 5};      /* 808, 909, CR78, FM: DRUM_PRESETS */
static const uint8_t KITV[4] = {4, 5, 7, 8};        /* DK_808, DK_909, DK_CR78, DK_FM */

static void render_case(const char *tag, uint32_t kit, const int16_t *e, const uint8_t *ln, const int8_t *patch,
                        const ev_t *ev, uint32_t nev, uint32_t nblocks)
{
    int32_t out[CTL];
    uint32_t b, k, j;
    host_tracks_init();
    memset(trk[0].v, 0, NVOICE * sizeof *trk[0].v);
    eng_state_reset();
    host_preset(&trk[0], ENGI_DRUM, PRESET[kit]);
    for (k = 0; k < 8u; k++)
        trk[0].p[P_E0 + k] = e[k];
    trk[0].p[P_E0] = KITV[kit];
    for (k = 0; k < 8u; k++)
        trk[0].p[P_LN0 + k] = ln[k];
    memset(&drum_patch[0], 0, sizeof drum_patch[0]);
    if (patch)
        memcpy(&drum_patch[0], patch, 64);
    dith_r = DITH_SEED;
    H = 14695981039346656037ull;
    PEAK = 0;
    for (b = 0; b < nblocks; b++) {
        dither_block();
        for (j = 0; j < nev; j++)
            if (ev[j].block == b) {
                drum_event_pitch = ev[j].pitch;
                drum_event_length = ev[j].len;
                trk_note_on(&trk[0], ev[j].note, ev[j].vel);
                drum_event_pitch = 0;
                drum_event_length = 0;
            }
        track_render(&trk[0], out, CTL);
        for (k = 0; k < CTL; k++) {
            hfnv((uint32_t)out[k]);
            PEAK = abs(out[k]) > PEAK ? abs(out[k]) : PEAK;
        }
    }
    printf("%s %016llx %d\n", tag, (unsigned long long)H, PEAK);
}

static const uint8_t SOUND_NOTE[16] = {36, 38, 41, 45, 50, 37, 39, 42, 46, 49, 51, 64, 61, 60, 75, 70};
static const int16_t V[4][8] = {
    {0, 64, 64, 64, 64, 100, 0, 0}, {0, 20, 100, 30, 110, 40, 1, 60}, {0, 110, 10, 120, 5, 127, 0, 0}, {0, 64, 64, 64, 64, 100, 1, 127},
};
static const uint8_t LN127[8] = {127, 127, 127, 127, 127, 127, 127, 127};

int main(void)
{
    static const char *const KN[4] = {"808", "909", "cr78", "fm"};
    char tag[64];
    uint32_t kit, i, v, n, c;
    /* the shared helpers the ports restate: a hash of each over its whole range */
    {
        uint64_t h = 14695981039346656037ull;
        #define F(x) do { uint32_t x_ = (uint32_t)(x); for (int k_ = 0; k_ < 4; k_++) { h ^= (x_ >> (8 * k_)) & 255u; h *= 1099511628211ull; } } while (0)
        for (int32_t d = -3072; d <= 3072; d++) F(pow2_q16(d));
        printf("unit pow2 %016llx\n", (unsigned long long)h); h = 14695981039346656037ull;
        for (int32_t x = -40000; x <= 40000; x += 3) F(softclip(x));
        printf("unit softclip %016llx\n", (unsigned long long)h); h = 14695981039346656037ull;
        for (uint32_t ph = 0; ph < 0xFFFFFFFFu - 0x100003u; ph += 0x100003u) F(sine_i(ph));
        printf("unit sine %016llx\n", (unsigned long long)h); h = 14695981039346656037ull;
        for (int k = 0; k < 1025; k++) { fm_bits_t b; b.f = P5_TANH[k]; F(b.u); }
        printf("unit tanh %016llx\n", (unsigned long long)h); h = 14695981039346656037ull;
        for (int k = 0; k < 2000; k++) { dither_block(); for (int j = 0; j < 32; j++) F((uint32_t)(int32_t)dith[j]); }
        printf("unit dither %016llx\n", (unsigned long long)h); h = 14695981039346656037ull;
        for (int k = 0; k < 256; k++) { fm_bits_t b; b.f = fm_exp2f((float)(k - 128) / 7.0f); F(b.u); b.f = fm_tanf((float)k * 0.0061f); F(b.u); b.f = fm_log2f((float)k * 0.37f + 0.01f); F(b.u); b.f = fm_expf((float)(k - 128) / 9.0f); F(b.u); b.f = fm_sinf((float)(k - 128) * 0.31f); F(b.u); }
        printf("unit fastmath %016llx\n", (unsigned long long)h);
        #undef F
    }
    /* (voice_budget() 16 and voice_units() 2 on the host: a part's eight voices fit the shared budget, so no case steals) */
    for (kit = 0; kit < 4u; kit++) {
        /* every GM note, two velocities, the four knob sets: 120 blocks */
        for (n = 35; n <= 81u; n++)
            for (v = 0; v < 4u; v++)
                for (c = 0; c < 2u; c++) {
                    ev_t ev = {0, (uint8_t)n, (uint8_t)(c ? 110 : 30), 0, 0};
                    snprintf(tag, sizeof tag, "%s/n%u/v%u/%u", KN[kit], n, v, c);
                    render_case(tag, kit, V[v], LN127, 0, &ev, 1, 120);
                }
        /* each of the 16 sounds to its end (3.3 s) */
        for (i = 0; i < 16u; i++) {
            ev_t ev = {0, SOUND_NOTE[i], 100, 0, 0};
            snprintf(tag, sizeof tag, "%s/long%u", KN[kit], i);
            render_case(tag, kit, V[0], LN127, 0, &ev, 1, 4500);
        }
        /* random sequences: knobs, lane levels, HIT-page patches, event pitch and length, hits */
        for (c = 0; c < 150u; c++) {
            int16_t e[8];
            uint8_t ln[8];
            int8_t patch[64];
            ev_t ev[16];
            uint8_t pool[8];
            uint32_t np = 2 + rn(5), ne = 6 + rn(10), t = 0, usepatch = rn(3) == 0, uselane = rn(3) == 0;
            rs = 0x1234567u + c * 7919u + kit * 104729u;
            e[0] = 0;
            for (i = 1; i < 8u; i++)
                e[i] = (int16_t)(i == 6 ? rn(2) : i == 7 ? (rn(3) ? 0 : rn(128)) : rn(128));
            for (i = 0; i < 8u; i++)
                ln[i] = (uint8_t)(uselane ? rn(128) : 127);
            for (i = 0; i < 64u; i++)
                patch[i] = 0;
            if (usepatch)
                for (i = 0; i < 16u; i++) {
                    patch[i * 4] = (int8_t)((int32_t)rn(49) - 24);
                    patch[i * 4 + 1] = (int8_t)((int32_t)rn(128) - 64);
                    patch[i * 4 + 2] = (int8_t)((int32_t)rn(128) - 64);
                    patch[i * 4 + 3] = (int8_t)rn(128);
                }
            for (i = 0; i < np; i++)
                pool[i] = (uint8_t)(rn(5) == 0 ? 35 + rn(47) : SOUND_NOTE[rn(16)]);
            if (rn(2)) { pool[0] = 42; if (np > 1) pool[1] = 46; if (np > 2) pool[2] = 44; }
            for (i = 0; i < ne; i++) {
                t += rn(24);
                ev[i].block = (uint16_t)t;
                ev[i].note = pool[rn(np)];
                ev[i].vel = (uint8_t)(1 + rn(127));
                ev[i].pitch = (int16_t)(rn(4) == 0 ? (int32_t)rn(33) - 16 : 0);
                ev[i].len = (uint16_t)(rn(5) == 0 ? 200 + rn(8000) : 0);
            }
            snprintf(tag, sizeof tag, "%s/seq%u", KN[kit], c);
            render_case(tag, kit, e, ln, patch, ev, ne, t + 200 + rn(300));
        }
    }
    return 0;
}
