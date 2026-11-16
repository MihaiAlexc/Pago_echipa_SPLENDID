/**
 * Vocea, abstractizată: azi folosim vocea din browser (Web Speech API, ro-RO),
 * mâine putem pune un serviciu cloud fără să schimbăm restul aplicației.
 */

export interface SpeechToText {
  readonly supported: boolean;
  /** Ascultă o frază. `onPartial` primește textul pe măsură ce vorbești. Întoarce fraza finală. */
  listen(onPartial?: (text: string) => void): Promise<string>;
  stop(): void;
}

export interface TextToSpeech {
  readonly supported: boolean;
  speak(text: string): Promise<void>;
  stop(): void;
}

export class SpeechError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const STT_MESSAGES: Record<string, string> = {
  "not-allowed": "Microfonul e blocat. Permite accesul la microfon din setările browserului.",
  "service-not-allowed": "Microfonul e blocat. Permite accesul la microfon din setările browserului.",
  "no-speech": "Nu am auzit nimic. Mai încearcă.",
  "audio-capture": "Nu găsesc microfonul.",
  network: "Recunoașterea vocală are nevoie de internet.",
};

// Tipuri minime pentru Web Speech API (nu sunt în lib.dom pentru toate browserele).
interface RecognitionResult { isFinal: boolean; 0: { transcript: string } }
interface RecognitionEvent { results: ArrayLike<RecognitionResult> }
interface Recognition {
  lang: string; interimResults: boolean; maxAlternatives: number;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type RecognitionCtor = new () => Recognition;

export class BrowserSpeechToText implements SpeechToText {
  private Ctor: RecognitionCtor | undefined;
  private current: Recognition | null = null;

  constructor(private lang = "ro-RO") {
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    this.Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  }

  get supported() {
    return Boolean(this.Ctor) && window.isSecureContext;
  }

  listen(onPartial?: (text: string) => void): Promise<string> {
    if (!this.Ctor) return Promise.reject(new SpeechError("unsupported", "Browserul nu suportă recunoașterea vocală. Folosește Chrome sau scrie mesajul."));
    if (!window.isSecureContext) return Promise.reject(new SpeechError("insecure", "Microfonul merge doar pe HTTPS sau localhost."));
    this.stop();

    return new Promise((resolve, reject) => {
      const rec = new this.Ctor!();
      this.current = rec;
      rec.lang = this.lang;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      let finalText = "";
      let failed = false;

      rec.onresult = (e) => {
        let text = "";
        for (let i = 0; i < e.results.length; i++) {
          text += e.results[i][0].transcript;
          if (e.results[i].isFinal) finalText = text;
        }
        onPartial?.(text);
      };
      rec.onerror = (e) => {
        failed = true;
        if (e.error === "aborted") return resolve("");
        reject(new SpeechError(e.error, STT_MESSAGES[e.error] ?? `Eroare la microfon (${e.error}).`));
      };
      rec.onend = () => {
        this.current = null;
        if (!failed) resolve(finalText.trim());
      };
      rec.start();
    });
  }

  stop() {
    this.current?.stop();
    this.current = null;
  }
}

export class BrowserTextToSpeech implements TextToSpeech {
  constructor(private lang = "ro-RO") {}

  get supported() {
    return "speechSynthesis" in window;
  }

  private voice(): SpeechSynthesisVoice | undefined {
    const voices = speechSynthesis.getVoices();
    return voices.find((v) => v.lang.toLowerCase() === this.lang.toLowerCase())
      ?? voices.find((v) => v.lang.toLowerCase().startsWith(this.lang.slice(0, 2).toLowerCase()));
  }

  speak(text: string): Promise<void> {
    if (!this.supported || !text) return Promise.resolve();
    speechSynthesis.cancel();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.lang;
      const v = this.voice();
      if (v) u.voice = v;
      u.rate = 1;
      u.onend = () => resolve();
      u.onerror = () => resolve(); // întreruperea nu e o eroare
      speechSynthesis.speak(u);
    });
  }

  stop() {
    if (this.supported) speechSynthesis.cancel();
  }
}
