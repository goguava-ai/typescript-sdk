// Seconds from the start of bar 0 to the given 0-indexed beat.
function beatTime(beat: number, bpm: number): number {
  return beat * (60 / bpm);
}

export interface ConnectingTone {
  start(): void;
  stop(): void;
}

// North American ringback: 440 + 480 Hz, 2s on, 4s off.
export class RingbackTone implements ConnectingTone {
  private context: AudioContext | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  private readonly volume = 0.15;
  private readonly onSeconds = 2;
  private readonly periodSeconds = 6;
  // Delay before the first ring, so near-instant connections stay silent.
  private readonly startDelay = 0.3;

  start(): void {
    if (this.context) return;

    const context = new AudioContext();
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(context.destination);

    for (const frequency of [440, 480]) {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start();
    }

    let nextRing = context.currentTime + this.startDelay;
    const ring = () => {
      gain.gain.setValueAtTime(this.volume, nextRing);
      gain.gain.setValueAtTime(0, nextRing + this.onSeconds);
      nextRing += this.periodSeconds;
    };
    ring();
    this.intervalId = setInterval(ring, this.periodSeconds * 1000);
    this.context = context;
  }

  stop(): void {
    if (!this.context) return;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    // Closing the context stops the oscillators.
    void this.context.close();
    this.context = null;
  }
}

export class JingleTone implements ConnectingTone {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private pulseCount = 0;
  // Audio-clock time of the next bar to schedule.
  private nextBarStart = 0;

  // Configuration
  private readonly volume = 0.3;
  private readonly bpm = 120;
  private readonly beatsPerBar = 4;
  // Delay before the first note, so near-instant connections stay silent.
  private readonly startDelay = 0.3;

  start(): void {
    if (this.running) return;

    this.running = true;
    this.pulseCount = 0;
    this.context = new AudioContext();
    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = this.volume;
    this.masterGain.connect(this.context.destination);
    this.nextBarStart = this.context.currentTime + this.startDelay;

    // Stay one bar ahead so timer jitter doesn't shift the beat.
    this.playPulse();
    this.playPulse();

    const barLength = beatTime(this.beatsPerBar, this.bpm);
    this.intervalId = setInterval(() => {
      this.playPulse();
    }, barLength * 1000);
  }

  private noteToFrequency(note: string): number {
    const match = note.match(/^([A-G])(#|b)?(-?\d+)$/);

    if (!match) {
      throw new Error(`Invalid note: ${note}`);
    }

    const [, name, accidental, octave] = match;

    const semitones: Record<string, number> = {
      C: 0,
      D: 2,
      E: 4,
      F: 5,
      G: 7,
      A: 9,
      B: 11,
    };

    const offset = accidental === "#" ? 1 : accidental === "b" ? -1 : 0;
    const midi = (Number(octave) + 1) * 12 + semitones[name] + offset;

    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    const context = this.context;
    const gain = this.masterGain;

    if (!context || !gain) return;

    // Smooth fade-out
    const now = context.currentTime;
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.15);

    setTimeout(() => {
      void context.close();
    }, 200);

    this.context = null;
    this.masterGain = null;
  }

  private playPulse(): void {
    if (!this.context || !this.masterGain) return;

    const bar = this.nextBarStart;
    const beat = (n: number) => bar + beatTime(n, this.bpm);
    const beatLength = beatTime(1, this.bpm);

    // Notes on beats 1-3, silence on beat 4.
    if (this.pulseCount % 4 === 0 || this.pulseCount % 4 === 2) {
      this.playNote("C5", beat(0), beatLength);
      this.playNote("E5", beat(0.5), beatLength);
      this.playNote("G4", beat(1), beatLength);
    } else if (this.pulseCount % 4 === 3) {
      this.playNote("E5", beat(0), beatLength);
      this.playNote("G5", beat(0.5), beatLength);
      this.playNote("C5", beat(1), beatLength);
    } else {
      this.playNote("E5", beat(0), beatLength);
      this.playNote("G4", beat(0.5), beatLength);
      this.playNote("C5", beat(1), beatLength);
    }
    this.pulseCount++;
    this.nextBarStart = beat(this.beatsPerBar);
  }

  private playNote(note: string, startTime: number, duration: number): void {
    if (!this.context || !this.masterGain) return;

    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = this.noteToFrequency(note);

    envelope.gain.setValueAtTime(0, startTime);
    envelope.gain.linearRampToValueAtTime(0.7, startTime + 0.05);
    envelope.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    oscillator.connect(envelope);
    envelope.connect(this.masterGain);

    oscillator.start(startTime);
    oscillator.stop(startTime + duration + 0.01);

    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
    };
  }
}

export interface Tone {
  play(): void;
}

export class LeavingTone implements Tone {
  public play(): void {
    const ctx = new AudioContext();

    if (ctx.state === "suspended") {
      void ctx.resume();
    }

    const now = ctx.currentTime;

    // First note: D4
    const first = this.playNote(ctx, {
      frequency: 293.665,
      startTime: now,
      attack: 0.065,
      decay: 0.085,
      volume: 0.2,
    });

    // Second note: A3, starts 139ms later
    const second = this.playNote(ctx, {
      frequency: 220.0,
      startTime: now + 0.139,
      attack: 0.018,
      decay: 0.075,
      volume: 0.2,
    });

    void Promise.all([first, second]).then(() => ctx.close());
  }

  // Resolves once the note has finished playing.
  private playNote(
    ctx: AudioContext,
    {
      frequency,
      startTime,
      attack,
      decay,
      volume,
    }: {
      frequency: number;
      startTime: number;
      attack: number;
      decay: number;
      volume: number;
    },
  ): Promise<void> {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, startTime);

    // Smooth onset
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(volume, startTime + attack);

    // Exponential decay
    const peakTime = startTime + attack;
    const endTime = peakTime + decay * 5;

    gain.gain.setTargetAtTime(0.00001, peakTime, decay);

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.start(startTime);
    oscillator.stop(endTime);

    return new Promise((resolve) => {
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
        resolve();
      };
    });
  }
}
