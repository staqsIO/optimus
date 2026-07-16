"use client";

import { useEffect } from "react";

declare global {
  interface Window {
    autobot?: { isElectron?: boolean; platform?: string };
  }
}

export default function ElectronDetect() {
  useEffect(() => {
    if (window.autobot?.isElectron && window.autobot?.platform === "darwin") {
      document.body.classList.add("electron-mac");
    }
  }, []);
  return null;
}
