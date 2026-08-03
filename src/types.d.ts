// WebGPU type declarations
/// <reference types="@webgpu/types" />

// Extend Window interface for UI callbacks
interface Window {
    setupUICallbacks?: (callbacks: {
        translateFixed: (axis: number, shift: number) => void;
        rotateFixed: (axis: number, shift: number) => void;
        resetCamera: () => void;
    }) => void;
    updateFPS?: (fps: number) => void;
    setupUIControls?: (
        updateCloth: (id: string, value: number) => void,
        updateLighting: () => void,
        updateColors: () => void,
        switchMode: (mode: 'physics' | 'simple') => void
    ) => void;
    switchClothMode?: (mode: 'physics' | 'simple') => void;
    switchModeFn?: (mode: 'physics' | 'simple') => void;
    updateTriangleCount?: (count: number) => void;
    toggleWireframe?: () => void;
    toggleWireframeFn?: () => void;
}

// Declare WGSL shader imports
declare module '*.wgsl?raw' {
  const content: string;
  export default content;
}

declare module '*.obj?url' {
  const url: string;
  export default url;
}

declare module '*.worker?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}

