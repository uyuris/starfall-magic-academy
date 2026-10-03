// Module worker for the 星見の窓 hover lines (状態 5). placeRelationLines takes a few ms typically and up to ~0.9 s
// in the worst layouts, so the screen runs it here and never blocks the main thread. Protocol (the contract is
// validateOverlookLayoutReply in overlookClient.js): the page posts { id, input } — `input` is exactly
// placeRelationLines' input — and receives { id, ok:true, result } or { id, ok:false, error } for that id.
import { placeRelationLines } from './overlookLayout.js';

self.addEventListener('message', (event) => {
  const { id, input } = event.data;
  try {
    self.postMessage({ id, ok: true, result: placeRelationLines(input) });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message ?? error) });
  }
});
