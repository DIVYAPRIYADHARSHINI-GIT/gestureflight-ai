import { sniff } from './src/modules/AircraftFileProcessor';
import { readFileSync } from 'node:fs';
for (const [f,id] of [['test-wedge.stl','stl'],['notes.dwg','dwg'],['test-drawing.dxf','dxf']] as const) {
  const b=new Uint8Array(readFileSync('tests/fixtures/files/'+f));
  const t0=Date.now();
  const r=sniff(id,b);
  console.log(f.padEnd(20), id.padEnd(5), '->', r, `${Date.now()-t0}ms`);
}
