/**
 * Satu sumber kebenaran untuk "turn sedang apa?".
 *
 * Sebelumnya status chat diturunkan dari 6 sinyal yang saling tumpang tindih
 * (busy, isTerminated, liveActivity, isHoldingLease, polledActivity, allClear).
 * Setiap bug status (processing→allclear→processing, thinking box nyangkut,
 * auto-scroll mati, jawaban tidak muncul) lahir dari kombinasi sinyal itu.
 *
 * Modul ini murni (tanpa React, tanpa I/O) supaya bisa diuji langsung:
 *   node --test tests/turnState.test.cjs
 *
 * Aturan yang dijaga:
 *  - `message.complete` (terminal event) SELALU menang atas lease backend.
 *  - Lease backend yang nempel (sesi TUI) tidak boleh menahan thinking box
 *    setelah turn dibuktikan selesai (WS atau bukti transcript/REST).
 *  - Delta yang masih mengalir (<3s) berarti streaming, bukan idle.
 */

export type TurnPhase = 'idle' | 'thinking' | 'streaming' | 'done';

export type TurnInputs = {
  /** WebSocket siap dipakai. */
  connected: boolean;
  /** Turn yang kita submit masih dianggap berjalan (state lokal). */
  busy: boolean;
  /** Turn ini sudah dibuktikan selesai (WS message.complete atau bukti transcript). */
  turnDone: boolean;
  /** Backend masih memegang turn lease untuk sesi ini. */
  leaseActive: boolean;
  /** Ada aktivitas live (tool/progress) dari event atau transcript tail. */
  liveActive: boolean;
  /** Jendela "all clear" 3 detik setelah turn selesai. */
  allClear: boolean;
  /** Waktu delta terakhir (ms epoch), 0 kalau tidak ada. */
  lastDeltaAt: number;
  /** Waktu terminal event terakhir (ms epoch), 0 kalau tidak ada. */
  terminalAt: number;
  /** Waktu turn ini dimulai (ms epoch), 0 kalau belum ada turn. */
  turnStart: number;
  /** Sekarang (ms epoch) — diinjeksi supaya fungsi tetap murni. */
  now: number;
  /** Delta dianggap "masih menulis" selama ini (ms). */
  streamWindowMs?: number;
};

export type TurnState = {
  phase: TurnPhase;
  /** Ada terminal event untuk turn ini. */
  terminated: boolean;
  /** Delta masih mengalir dan turn belum ditutup. */
  streaming: boolean;
  /** Masih ada kerja berjalan (lokal, lease, atau aktivitas live). */
  working: boolean;
  /** Tampilkan thinking box. */
  thinking: boolean;
  /** Tampilkan status processing di composer. */
  processing: boolean;
  /** Union yang dipakai untuk badge/token/auto-scroll. */
  busyOrActive: boolean;
  /** Kerja berjalan tapi BUKAN dari client ini (mis. sesi sama dibuka di TUI/HP lain). */
  remote: boolean;
  /** Label singkat untuk UI. */
  label: string;
};

const DEFAULT_STREAM_WINDOW_MS = 3000;

export function deriveTurnState(input: TurnInputs): TurnState {
  const windowMs = input.streamWindowMs ?? DEFAULT_STREAM_WINDOW_MS;
  const { connected, busy, turnDone, leaseActive, liveActive, allClear, now } = input;

  // Terminal event hanya dihitung kalau terjadi SETELAH turn ini mulai.
  // Tanpa cek ini, `message.complete` dari turn sebelumnya langsung menutup turn baru.
  const terminalAt = Number.isFinite(input.terminalAt) ? input.terminalAt : 0;
  const turnStart = Number.isFinite(input.turnStart) ? input.turnStart : 0;
  const terminalForThisTurn = terminalAt > 0 && (turnStart === 0 || terminalAt > turnStart);
  const terminated = terminalForThisTurn || turnDone;

  // Delta baru = sedang menulis. Ditutup oleh allClear/terminal.
  const lastDeltaAt = Number.isFinite(input.lastDeltaAt) ? input.lastDeltaAt : 0;
  const deltaFresh = lastDeltaAt > 0 && now - lastDeltaAt < windowMs;
  const streaming = connected && !allClear && !terminated && deltaFresh;

  // Kerja berjalan: state lokal menang; lease/live hanya boleh menahan box
  // SELAMA turn belum dibuktikan selesai.
  const working = busy || (!terminated && (leaseActive || liveActive));

  // Jendela "all clear" menyembunyikan status turn yang BARU selesai, tapi tidak
  // boleh menahan turn yang benar-benar sedang dikerjakan (busy selalu menang).
  const visible = !allClear || busy;

  const thinking = connected && !terminated && working && visible;
  const processing = connected && !terminated && working && visible;
  const busyOrActive = processing || streaming;
  // Kerja ada, tapi bukan turn yang kita submit → indikasikan sebagai "perangkat lain".
  const remote = !busy && working;

  let phase: TurnPhase = 'idle';
  if (!connected) phase = 'idle';
  else if (streaming) phase = 'streaming';
  else if (thinking) phase = 'thinking';
  else if (terminated) phase = 'done';

  let label = '';
  if (remote) label = 'Dikerjakan di perangkat lain…';
  else if (phase === 'streaming') label = 'Menulis balasan…';
  else if (phase === 'thinking') label = 'Processing…';

  return { phase, terminated, streaming, working, thinking, processing, busyOrActive, remote, label };
}
