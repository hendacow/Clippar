import { requireNativeModule } from "expo-modules-core";

// This will throw if the native module is not available (e.g., in Expo Go).
// The index.ts wrapper catches this and provides a graceful fallback.
export default requireNativeModule("ShotDetector");
