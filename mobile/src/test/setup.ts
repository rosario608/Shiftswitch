import "@testing-library/react";

/**
 * The native plugins are not available under jsdom. Each mock is the honest
 * web-platform behaviour of that plugin, so a test exercises the same branches
 * the app takes on a device where a capability is missing.
 */
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
  },
}));

vi.mock("@capacitor/haptics", () => ({
  Haptics: { impact: vi.fn(), notification: vi.fn() },
  ImpactStyle: { Light: "LIGHT" },
  NotificationType: { Success: "SUCCESS", Warning: "WARNING" },
}));

vi.mock("@capacitor/browser", () => ({
  Browser: { open: vi.fn(), close: vi.fn() },
}));

vi.mock("@capacitor/push-notifications", () => ({
  PushNotifications: {
    checkPermissions: vi.fn(async () => ({ receive: "prompt" })),
    requestPermissions: vi.fn(async () => ({ receive: "granted" })),
    register: vi.fn(),
    unregister: vi.fn(),
    createChannel: vi.fn(),
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
    removeAllDeliveredNotifications: vi.fn(),
  },
}));

vi.mock("@capacitor/device", () => ({
  Device: {
    getInfo: vi.fn(async () => ({
      operatingSystem: "unknown",
      osVersion: "0",
      model: "test",
    })),
  },
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
    getLaunchUrl: vi.fn(async () => null),
    exitApp: vi.fn(),
  },
}));

vi.mock("@aparajita/capacitor-secure-storage", () => ({
  SecureStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

// Adds toHaveTextContent and friends.
await import("@testing-library/jest-dom/vitest");
