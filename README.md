# WebSynth

A software FM synthesizer for the web, in TypeScript (Vite + Web Audio `AudioWorklet`).

The engine in `src/fm6/` is a bit-exact port of the 6-operator FM core of [Felucca](https://github.com/hugelton/Felucca)
(itself a port of msfa, the DX7-compatible core of Dexed). See `NOTICE`.

- `npm run dev` runs the app. `npm test` checks the port against reference output of the C original.
- Instruments: the 6-operator FM engine, eleven more engines (ANALOG, LOFI, TRIO, WHEEL, NOISE, PHASE, VOICE, PHYS, SAMPLE, GRAIN, SLICE) and a
  drum machine with nine kits, all ported from Felucca / Felucca-Engines and checked bit for bit against their C code.
- Effects: per-track distortion and sends into chorus, tempo delay and a ROOM / SPRING / HALL reverb, then a limiter.
- The patch library has 33 built-in voices (INIT, 8 from Felucca, 24 written for WebSynth). It also imports and exports DX7 `.syx` banks.

Licensed GPL-3.0 (see `LICENSE`).
