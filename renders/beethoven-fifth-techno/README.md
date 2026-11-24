# Beethoven, Symphony No. 5 (1st movement) as techno

An offline render made with the WebSynth engine (not part of the app). The melodies are the real notes of the score,
taken from the public-domain Breitkopf edition on the Mutopia Project (`s5.mid`,
https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=941); the drums, acid bass and stabs are arranged on top.

- `symphony5-techno.mp3` - the result (98 s, 130 BPM)
- `parse.py` -> `s5.json`; `gen.py` -> `score.json` (the sections used: bars 1-5, 6-21, 22-34, 59-70, 110-126, 240-251, 485-507)
- `lib.ts` - note notation, song builder, offline renderer, WAV writer; `fifth.ts` - the arrangement

Run: `npx esbuild renders/beethoven-fifth-techno/fifth.ts --bundle --platform=node --format=cjs --outfile=/tmp/f.cjs && node /tmp/f.cjs out.wav`
(`parse.py` and `gen.py` read and write `s5.mid`/`s5.json` in the current directory.)
