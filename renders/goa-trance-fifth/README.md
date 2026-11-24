# Goa trance on the Fifth's motto

An offline render with the WebSynth engine (not part of the app): 142 BPM, 72 bars, a rolling bass on the motto's roots
(G Eb F D), a mutating "g g g eb / f f f d" ostinato, a 7-step cycle against the 16-step bar and long filter sweeps (a free
LFO with a 20 s cycle). The motto itself sits far back, low-pass filtered. Written in `goa.ts`, using `../beethoven-fifth-techno/lib.ts`.

Run: `npx esbuild renders/goa-trance-fifth/goa.ts --bundle --platform=node --format=cjs --outfile=/tmp/goa.cjs && node /tmp/goa.cjs out.wav`
