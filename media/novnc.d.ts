/**
 * Minimal ambient typings for the parts of noVNC's RFB client we use.
 * The upstream package ships no TypeScript declarations.
 */
declare module '@novnc/novnc' {
  export interface RFBCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export interface RFBOptions {
    shared?: boolean;
    credentials?: RFBCredentials;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RFBOptions);

    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;

    disconnect(): void;
    sendCredentials(credentials: RFBCredentials): void;
    sendKey(keysym: number, code?: string, down?: boolean): void;
    sendCtrlAltDel(): void;
    focus(): void;
    blur(): void;
    machineShutdown(): void;
    machineReboot(): void;
    machineReset(): void;
    clipboardPasteFrom(text: string): void;

    addEventListener(type: string, listener: (event: any) => void): void;
    removeEventListener(type: string, listener: (event: any) => void): void;
  }
}
