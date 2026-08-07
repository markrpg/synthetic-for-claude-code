declare module "vanta/dist/vanta.waves.min.js" {
  import type * as Three from "three";

  export interface VantaWavesOptions {
    el: HTMLElement;
    THREE: typeof Three;
    backgroundAlpha?: number;
    backgroundColor?: number;
    color?: number;
    forceAnimate?: boolean;
    gyroControls?: boolean;
    minHeight?: number;
    minWidth?: number;
    mouseControls?: boolean;
    scale?: number;
    scaleMobile?: number;
    shininess?: number;
    touchControls?: boolean;
    waveHeight?: number;
    waveSpeed?: number;
    zoom?: number;
  }

  export interface VantaWavesEffect {
    destroy(): void;
    onUpdate(): void;
    resize(): void;
    plane: Three.Mesh<Three.BufferGeometry, Three.MeshPhongMaterial>;
    scene: Three.Scene;
    ww: number;
    hh: number;
  }

  const createVantaWaves: (
    options: VantaWavesOptions,
  ) => VantaWavesEffect | undefined;

  export default createVantaWaves;
}
