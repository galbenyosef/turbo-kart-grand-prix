// Assembles the trailer from the captured shot frames (shots/sNN_####.jpg) + shots/music.wav.
// Per-shot: title cards (drawtext), quick white-flash cuts; then concat and mux the music.
// Usage: node tools/build-trailer.mjs [outFile]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SHOTS = path.join(ROOT, 'shots');
const OUT = process.argv[2] || path.join(ROOT, 'docs', 'trailer.mp4');
const FPS = 30;
const FONT = 'C\\:/Windows/Fonts/ariblk.ttf';   // Arial Black (escaped for the filtergraph)
const FONT_SUB = 'C\\:/Windows/Fonts/arialbd.ttf';

const YELLOW = '#FFD54F', WHITE = '#FFFFFF';

/** drawtext with a thick black border + drop shadow, centred at y (expression), shown in [from, to). */
function title(text, { size = 96, y = '(h-text_h)/2', from = 0, to = 999, color = YELLOW, font = FONT, x = '(w-text_w)/2' } = {}) {
  const safe = text.replace(/\\/g, '\\\\').replace(/'/g, "\u2019").replace(/:/g, '\\:').replace(/,/g, '\\,');
  return `drawtext=fontfile='${font}':text='${safe}':fontsize=${size}:fontcolor=${color}:borderw=${Math.round(size * 0.075)}:bordercolor=black:shadowx=${Math.round(size * 0.05)}:shadowy=${Math.round(size * 0.05)}:shadowcolor=black@0.55:x=${x}:y=${y}:enable='between(t\\,${from}\\,${to})'`;
}

const shots = [
  { id: 's01', fadeIn: ['black', 0.8], texts: [
    title('TURBO KART', { size: 118, y: 'h*0.24', from: 1.3 }),
    title('GRAND PRIX', { size: 62, y: 'h*0.24+140', from: 1.7, color: WHITE }),
  ] },
  { id: 's02', texts: [title('THE CROWD IS READY', { size: 70, y: 'h*0.80', from: 0.4 })] },
  { id: 's03', texts: [
    title('3', { size: 220, from: 0.0, to: 0.83 }),
    title('2', { size: 220, from: 0.83, to: 1.66 }),
    title('1', { size: 220, from: 1.66, to: 2.5 }),
    title('GO!', { size: 220, from: 2.5, to: 3.5, color: '#66FF66' }),
  ] },
  { id: 's04', texts: [title('8 RACERS.  3 LAPS.', { size: 76, y: 'h*0.80', from: 0.5 })] },
  { id: 's05', texts: [title('DRIFT FOR TURBO', { size: 76, y: 'h*0.80', from: 0.4 })] },
  { id: 's06', texts: [title('LOCK ON!', { size: 84, y: 'h*0.78', from: 0.6 })] },
  { id: 's07', texts: [title('GO INVINCIBLE', { size: 76, y: 'h*0.80', from: 0.3 })] },
  { id: 's08', texts: [title('CLIMB THE HILL', { size: 76, y: 'h*0.80', from: 0.3 })] },
  { id: 's09', texts: [title('TAKE THE FLAG', { size: 84, y: 'h*0.80', from: 0.5 })] },
  { id: 's10', fadeOut: ['black', 1.2], texts: [
    title('TURBO KART', { size: 104, y: 'h*0.16', from: 0.3 }),
    title('GRAND PRIX', { size: 54, y: 'h*0.16+125', from: 0.5, color: WHITE }),
    title('PLAY FREE IN YOUR BROWSER', { size: 40, y: 'h*0.74', from: 1.2, color: WHITE, font: FONT_SUB }),
    title('turbo-kart-grand-prix.vercel.app', { size: 40, y: 'h*0.74+58', from: 1.5, font: FONT_SUB }),
  ] },
];

function run(args, label) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${label}`);
}

const list = [];
let total = 0;
for (const s of shots) {
  const frames = fs.readdirSync(SHOTS).filter((f) => f.startsWith(s.id + '_') && f.endsWith('.jpg')).length;
  if (!frames) { console.warn(`skip ${s.id}: no frames`); continue; }
  const dur = frames / FPS;
  const filters = [...s.texts];
  const [inColor, inDur] = s.fadeIn || ['white', 0.18];
  const [outColor, outDur] = s.fadeOut || ['white', 0.18];
  filters.push(`fade=t=in:st=0:d=${inDur}:color=${inColor}`);
  filters.push(`fade=t=out:st=${(dur - outDur).toFixed(3)}:d=${outDur}:color=${outColor}`);
  const out = path.join(SHOTS, `${s.id}.mp4`);
  run(['-framerate', String(FPS), '-i', path.join(SHOTS, `${s.id}_%04d.jpg`), '-vf', filters.join(','),
       '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', String(FPS), out], s.id);
  list.push(`file '${out.replace(/\\/g, '/')}'`);
  total += dur;
  console.log(`${s.id}: ${frames} frames (${dur.toFixed(1)} s)`);
}
const listFile = path.join(SHOTS, 'concat.txt');
fs.writeFileSync(listFile, list.join('\n') + '\n');
const silent = path.join(SHOTS, 'trailer_silent.mp4');
run(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', silent], 'concat');
const music = path.join(SHOTS, 'music.wav');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
run(['-i', silent, '-i', music, '-filter:a', `afade=t=out:st=${(total - 2.5).toFixed(2)}:d=2.5`,
     '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUT], 'mux');
console.log(`trailer: ${OUT} (${total.toFixed(1)} s, ${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
