// Regression tests untuk src/turnState.ts — satu sumber kebenaran status turn.
// Jalankan: npm run test:turn
//
// Setiap test di bawah mewakili bug nyata yang pernah terjadi di Cockpit:
//  1. processing → all clear → processing (flap) tepat setelah submit
//  2. thinking box + "processing" nyangkut setelah jawaban selesai streaming
//  3. lease backend yang nempel selamanya menahan thinking box
//  4. delta dari turn lama dianggap streaming turn baru
const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveTurnState } = require('../.tmp-tests/turnState.js');

const NOW = 1_700_000_000_000;
const TURN_START = NOW - 5_000;

/** Basis input: turn sedang berjalan, WS hidup, tidak ada event apa pun. */
function base(overrides = {}) {
  return {
    connected: true,
    busy: true,
    turnDone: false,
    leaseActive: false,
    liveActive: false,
    allClear: false,
    lastDeltaAt: 0,
    terminalAt: 0,
    turnStart: TURN_START,
    now: NOW,
    ...overrides,
  };
}

test('disconnected → idle, tidak ada indikator apa pun', () => {
  const s = deriveTurnState(base({ connected: false, busy: true, leaseActive: true }));
  assert.equal(s.phase, 'idle');
  assert.equal(s.thinking, false);
  assert.equal(s.processing, false);
  assert.equal(s.streaming, false);
  assert.equal(s.busyOrActive, false);
});

test('bug #1: tepat setelah submit (transcript masih basi) box TIDAK boleh hilang', () => {
  // Tidak ada event, lease belum terpegang, tail masih punya jawaban turn lama.
  const s = deriveTurnState(base({ busy: true, leaseActive: false, liveActive: false }));
  assert.equal(s.thinking, true, 'thinking box harus tetap tampil selama turn baru berjalan');
  assert.equal(s.processing, true);
  assert.equal(s.phase, 'thinking');
  assert.equal(s.label, 'Processing…');
});

test('bug #1b: lease hilang di tengah turn tidak boleh mematikan status', () => {
  const s = deriveTurnState(base({ busy: true, leaseActive: false, liveActive: false, terminalAt: 0 }));
  assert.equal(s.thinking, true);
});

test('bug #2: message.complete SELALU menang atas lease yang masih nempel', () => {
  const s = deriveTurnState(base({
    busy: false,
    leaseActive: true, // sesi TUI: lease nempel terus
    terminalAt: TURN_START + 1_000,
  }));
  assert.equal(s.terminated, true);
  assert.equal(s.thinking, false, 'thinking box wajib tutup setelah terminal event');
  assert.equal(s.processing, false);
  assert.equal(s.phase, 'done');
});

test('bug #2b: terminal event + busy yang terlanjur di-set ulang tetap dianggap selesai', () => {
  const s = deriveTurnState(base({
    busy: true, // poller sempat menghidupkan busy lagi
    leaseActive: true,
    terminalAt: TURN_START + 2_000,
  }));
  assert.equal(s.terminated, true);
  assert.equal(s.thinking, false);
  assert.equal(s.busyOrActive, false);
});

test('bug #3: message.complete dari turn SEBELUMNYA tidak menutup turn baru', () => {
  const s = deriveTurnState(base({
    busy: true,
    terminalAt: TURN_START - 1, // milidetik sebelum turn baru mulai
  }));
  assert.equal(s.terminated, false, 'event lama harus diabaikan');
  assert.equal(s.thinking, true);
  assert.equal(s.phase, 'thinking');
});

test('bug #4: turn yang sudah dibuktikan selesai (REST) lepas dari lease selamanya', () => {
  const s = deriveTurnState(base({ busy: false, turnDone: true, leaseActive: true, liveActive: true }));
  assert.equal(s.thinking, false);
  assert.equal(s.busyOrActive, false);
  assert.equal(s.phase, 'done');
});

test('streaming: delta baru (<3s) → phase streaming + label menulis', () => {
  const s = deriveTurnState(base({ lastDeltaAt: NOW - 500 }));
  assert.equal(s.streaming, true);
  assert.equal(s.thinking, true);
  assert.equal(s.phase, 'streaming');
  assert.equal(s.label, 'Menulis balasan…');
});

test('streaming berhenti: delta basi (>3s) kembali ke thinking, bukan idle', () => {
  const s = deriveTurnState(base({ lastDeltaAt: NOW - 4_000 }));
  assert.equal(s.streaming, false);
  assert.equal(s.thinking, true);
  assert.equal(s.phase, 'thinking');
});

test('all clear menutup streaming & thinking walau lease masih aktif', () => {
  // Kondisi nyata: turn sudah selesai (busy=false) tapi lease TUI masih nempel.
  const s = deriveTurnState(base({ busy: false, allClear: true, leaseActive: true, lastDeltaAt: NOW - 100 }));
  assert.equal(s.streaming, false);
  assert.equal(s.thinking, false);
  assert.equal(s.busyOrActive, false);
});

test('all clear TIDAK boleh menahan turn baru yang sudah submit (busy menang)', () => {
  const s = deriveTurnState(base({ busy: true, allClear: true, lastDeltaAt: NOW - 100 }));
  assert.equal(s.thinking, true);
  assert.equal(s.phase, 'thinking');
});

test('live activity (tool) tanpa busy tetap menampilkan thinking', () => {
  const s = deriveTurnState(base({ busy: false, liveActive: true }));
  assert.equal(s.thinking, true);
  assert.equal(s.processing, true);
});

test('idle total: tidak ada kerja, tidak ada event → phase idle', () => {
  const s = deriveTurnState(base({ busy: false, leaseActive: false, liveActive: false }));
  assert.equal(s.phase, 'idle');
  assert.equal(s.thinking, false);
  assert.equal(s.busyOrActive, false);
});

test('turnStart 0 (sesi baru, belum ada turn) tidak membuat terminal event lama dihitung', () => {
  const s = deriveTurnState(base({ turnStart: 0, terminalAt: NOW - 60_000, busy: false, leaseActive: false }));
  assert.equal(s.terminated, true);
  assert.equal(s.thinking, false);
});

test('remote: kerja dari perangkat lain ditandai, bukan "Processing"', () => {
  const s = deriveTurnState(base({ busy: false, leaseActive: true }));
  assert.equal(s.remote, true);
  assert.equal(s.thinking, true);
  assert.equal(s.label, 'Dikerjakan di perangkat lain…');
});

test('remote: turn yang kita submit sendiri TIDAK ditandai remote', () => {
  const s = deriveTurnState(base({ busy: true, leaseActive: true }));
  assert.equal(s.remote, false);
  assert.equal(s.label, 'Processing…');
});

test('remote: setelah terminal event, tanda remote ikut hilang', () => {
  const s = deriveTurnState(base({ busy: false, leaseActive: true, terminalAt: TURN_START + 500 }));
  assert.equal(s.remote, false);
  assert.equal(s.thinking, false);
});

test('stream window bisa dikonfigurasi (dipakai untuk tuning)', () => {
  const s = deriveTurnState(base({ lastDeltaAt: NOW - 900, streamWindowMs: 800 }));
  assert.equal(s.streaming, false);
  const s2 = deriveTurnState(base({ lastDeltaAt: NOW - 900, streamWindowMs: 1_000 }));
  assert.equal(s2.streaming, true);
});
