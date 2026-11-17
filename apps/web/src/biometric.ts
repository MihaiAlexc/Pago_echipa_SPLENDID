import { NativeBiometric } from "@capgo/capacitor-native-biometric";
import { isNative } from "./api.ts";

export type BiometricResult = "ok" | "cancelled" | "unavailable";

/**
 * Amprentă / Face Unlock înainte de plata confirmată cu butonul (doar în aplicația Android).
 * E un strat în PLUS pe telefon: plata tot serverul o confirmă, cu token-ul.
 * - În browser sau pe un telefon fără amprentă/blocare ecran → „unavailable” (plata continuă ca înainte).
 * - Utilizatorul a renunțat sau nu s-a recunoscut → „cancelled” (nu plătim).
 */
export async function verifyBiometric(reason: string): Promise<BiometricResult> {
  if (!isNative) return "unavailable";
  try {
    // useFallback: false = cere o amprentă / față înregistrată. Cu true, un telefon care are doar PIN ar apărea
    // „disponibil”, dar pe Android verificarea acceptă doar biometrie → utilizatorul n-ar mai putea plăti cu butonul.
    const { isAvailable } = await NativeBiometric.isAvailable({ useFallback: false });
    if (!isAvailable) return "unavailable";
  } catch {
    return "unavailable";
  }
  try {
    await NativeBiometric.verifyIdentity({
      reason,
      title: "Confirmă plata",
      subtitle: reason,
      negativeButtonText: "Anulează",
      useFallback: true,
      maxAttempts: 3,
    });
    return "ok";
  } catch {
    return "cancelled";
  }
}
