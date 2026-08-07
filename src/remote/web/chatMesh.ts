import * as THREE from "three";
import createVantaWaves, {
  type VantaWavesEffect,
} from "vanta/dist/vanta.waves.min.js";

export interface ChatMeshController {
  setActive(active: boolean): void;
  destroy(): void;
}

interface MeshPoint {
  x: number;
  y: number;
}

type RibbonEdge = "top" | "bottom";

interface MeshRibbon {
  edge: RibbonEdge;
  points: MeshPoint[][];
}

const TARGET_FRAME_INTERVAL = 1000 / 28;
const MAX_DEVICE_SCALE = 1.75;

export function createChatMesh(
  canvas: HTMLCanvasElement,
  vantaHost: HTMLElement,
  view: Window,
): ChatMeshController {
  const procedural = createProceduralMesh(canvas, view);
  const reducedMotion = view.matchMedia(
    "(prefers-reduced-motion: reduce)",
  );
  const document = canvas.ownerDocument;
  const canRenderWebGL = supportsWebGL(document);
  const vantaRenderScale = Math.max(
    1,
    (view.devicePixelRatio || 1) / 1.25,
  );
  let active = true;
  let destroyed = false;
  let effect: VantaWavesEffect | undefined;

  const stopVanta = (): void => {
    if (effect) {
      try {
        effect.destroy();
      } catch {
        // A lost WebGL context may already have disposed part of the effect.
      }
      effect = undefined;
    }
    vantaHost.replaceChildren();
    vantaHost.removeAttribute("data-active");
    canvas.removeAttribute("data-vanta-active");
  };

  const startVanta = (): boolean => {
    if (destroyed) {
      return false;
    }
    if (effect) {
      return true;
    }
    vantaHost.replaceChildren();
    try {
      const candidate = createVantaWaves({
        el: vantaHost,
        THREE,
        backgroundAlpha: 0,
        backgroundColor: 0x0d1214,
        color: 0xe54f72,
        forceAnimate: false,
        gyroControls: false,
        minHeight: 200,
        minWidth: 200,
        mouseControls: false,
        scale: vantaRenderScale,
        scaleMobile: vantaRenderScale,
        shininess: 0,
        touchControls: false,
        waveHeight: 58,
        waveSpeed: 0.14,
        zoom: 0.22,
      });
      if (!candidate || !vantaHost.querySelector("canvas.vanta-canvas")) {
        candidate?.destroy();
        vantaHost.replaceChildren();
        return false;
      }
      installWaveGrid(candidate, view);
      effect = candidate;
      vantaHost.dataset.active = "true";
      canvas.dataset.vantaActive = "true";
      procedural.setActive(false);
      return true;
    } catch {
      vantaHost.replaceChildren();
      return false;
    }
  };

  const applyRenderer = (): void => {
    const visible = document.visibilityState !== "hidden";
    const shouldUseVanta =
      active && visible && canRenderWebGL && !reducedMotion.matches;
    if (shouldUseVanta && startVanta()) {
      return;
    }
    stopVanta();
    procedural.setActive(active && visible);
  };

  const onMotionChange = (): void => applyRenderer();
  const onVisibilityChange = (): void => applyRenderer();
  const ResizeObserverConstructor = (
    view as Window & { ResizeObserver?: typeof ResizeObserver }
  ).ResizeObserver;
  const resizeObserver = ResizeObserverConstructor
    ? new ResizeObserverConstructor(() => effect?.resize())
    : undefined;
  resizeObserver?.observe(vantaHost);
  reducedMotion.addEventListener("change", onMotionChange);
  document.addEventListener("visibilitychange", onVisibilityChange);
  applyRenderer();

  return {
    setActive(nextActive: boolean): void {
      active = nextActive;
      applyRenderer();
    },
    destroy(): void {
      destroyed = true;
      reducedMotion.removeEventListener("change", onMotionChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      resizeObserver?.disconnect();
      stopVanta();
      procedural.destroy();
    },
  };
}

function installWaveGrid(effect: VantaWavesEffect, view: Window): void {
  const sourcePosition = effect.plane.geometry.getAttribute("position");
  const subdivision = 2;
  const sourceColumnCount = effect.ww + 1;
  const sourceRowCount = effect.hh + 1;
  const columnCount = effect.ww * subdivision + 1;
  const rowCount = effect.hh * subdivision + 1;
  const finePosition = new THREE.BufferAttribute(
    new Float32Array(columnCount * rowCount * 3),
    3,
  );
  const vertexIndex = (column: number, row: number): number =>
    column * rowCount + row;

  const mixValue = (start: number, end: number, amount: number): number =>
    start + (end - start) * amount;
  const updateFinePosition = (includeStaticAxes: boolean): void => {
    for (let column = 0; column < columnCount; column += 1) {
      const sourceColumn = column / subdivision;
      const columnStart = Math.floor(sourceColumn);
      const columnEnd = Math.min(
        sourceColumnCount - 1,
        columnStart + 1,
      );
      const columnMix = sourceColumn - columnStart;
      for (let row = 0; row < rowCount; row += 1) {
        const sourceRow = row / subdivision;
        const rowStart = Math.floor(sourceRow);
        const rowEnd = Math.min(sourceRowCount - 1, rowStart + 1);
        const rowMix = sourceRow - rowStart;
        const topStart = columnStart * sourceRowCount + rowStart;
        const topEnd = columnEnd * sourceRowCount + rowStart;
        const bottomStart = columnStart * sourceRowCount + rowEnd;
        const bottomEnd = columnEnd * sourceRowCount + rowEnd;
        const fineIndex = vertexIndex(column, row);

        const yTop = mixValue(
          sourcePosition.getY(topStart),
          sourcePosition.getY(topEnd),
          columnMix,
        );
        const yBottom = mixValue(
          sourcePosition.getY(bottomStart),
          sourcePosition.getY(bottomEnd),
          columnMix,
        );
        const y = mixValue(yTop, yBottom, rowMix);
        if (!includeStaticAxes) {
          finePosition.setY(fineIndex, y);
          continue;
        }
        const xTop = mixValue(
          sourcePosition.getX(topStart),
          sourcePosition.getX(topEnd),
          columnMix,
        );
        const xBottom = mixValue(
          sourcePosition.getX(bottomStart),
          sourcePosition.getX(bottomEnd),
          columnMix,
        );
        const zTop = mixValue(
          sourcePosition.getZ(topStart),
          sourcePosition.getZ(topEnd),
          columnMix,
        );
        const zBottom = mixValue(
          sourcePosition.getZ(bottomStart),
          sourcePosition.getZ(bottomEnd),
          columnMix,
        );
        finePosition.setXYZ(
          fineIndex,
          mixValue(xTop, xBottom, rowMix),
          y,
          mixValue(zTop, zBottom, rowMix),
        );
      }
    }
    finePosition.needsUpdate = true;
  };
  updateFinePosition(true);

  const addGridLayer = (
    step: number,
    color: number,
    opacity: number,
    renderOrder: number,
  ): void => {
    const indices: number[] = [];
    for (let column = 0; column < columnCount; column += step) {
      for (let row = 0; row < rowCount - 1; row += 1) {
        indices.push(
          vertexIndex(column, row),
          vertexIndex(column, row + 1),
        );
      }
    }
    for (let row = 0; row < rowCount; row += step) {
      for (let column = 0; column < columnCount - 1; column += 1) {
        indices.push(
          vertexIndex(column, row),
          vertexIndex(column + 1, row),
        );
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", finePosition);
    geometry.setIndex(indices);
    const material = new THREE.LineBasicMaterial({
      blending: THREE.AdditiveBlending,
      color,
      depthWrite: false,
      opacity,
      transparent: true,
    });
    const grid = new THREE.LineSegments(geometry, material);
    grid.frustumCulled = false;
    grid.renderOrder = renderOrder;
    effect.scene.add(grid);
  };

  addGridLayer(1, 0xb92f52, 0.24, 1);
  addGridLayer(12, 0xf04b70, 0.28, 2);
  effect.plane.visible = false;
  // Vanta's stock surface needs normals; our line grid does not. Skipping that
  // recalculation keeps the decorative effect substantially lighter on phones.
  effect.plane.geometry.computeVertexNormals = () => undefined;

  const update = effect.onUpdate.bind(effect);
  let previousUpdate = Number.NEGATIVE_INFINITY;
  effect.onUpdate = () => {
    const now = view.performance.now();
    if (now - previousUpdate < TARGET_FRAME_INTERVAL) {
      return;
    }
    previousUpdate = now;
    update();
    updateFinePosition(false);
  };
}

function createProceduralMesh(
  canvas: HTMLCanvasElement,
  view: Window,
): ChatMeshController {
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) {
    return { setActive: () => undefined, destroy: () => undefined };
  }

  const reducedMotion = view.matchMedia(
    "(prefers-reduced-motion: reduce)",
  );
  let active = true;
  let destroyed = false;
  let animationFrame: number | undefined;
  let lastFrame = 0;
  let width = 0;
  let height = 0;
  let deviceScale = 1;

  const resize = (): void => {
    const bounds = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(bounds.width));
    const nextHeight = Math.max(1, Math.round(bounds.height));
    const nextScale = Math.min(
      MAX_DEVICE_SCALE,
      Math.max(1, view.devicePixelRatio || 1),
    );
    if (
      nextWidth === width &&
      nextHeight === height &&
      nextScale === deviceScale
    ) {
      return;
    }
    width = nextWidth;
    height = nextHeight;
    deviceScale = nextScale;
    canvas.width = Math.round(width * deviceScale);
    canvas.height = Math.round(height * deviceScale);
    context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
    render(reducedMotion.matches ? 41_000 : view.performance.now());
  };

  const render = (time: number): void => {
    if (width <= 1 || height <= 1) {
      return;
    }
    const seconds = time / 1000;
    const ribbons: MeshRibbon[] = [
      buildRibbon(width, height, seconds, "top"),
      buildRibbon(width, height, seconds, "bottom"),
    ];

    context.clearRect(0, 0, width, height);
    context.save();
    context.globalCompositeOperation = "screen";
    context.lineCap = "round";

    for (const ribbon of ribbons) {
      drawRibbon(context, ribbon, seconds);
    }
    context.restore();
  };

  const schedule = (): void => {
    if (
      destroyed ||
      !active ||
      reducedMotion.matches ||
      canvas.ownerDocument.visibilityState === "hidden" ||
      animationFrame !== undefined
    ) {
      return;
    }
    animationFrame = view.requestAnimationFrame(tick);
  };

  const tick = (time: number): void => {
    animationFrame = undefined;
    if (time - lastFrame >= TARGET_FRAME_INTERVAL) {
      lastFrame = time;
      resize();
      render(time);
    }
    schedule();
  };

  const onMotionChange = (): void => {
    if (animationFrame !== undefined) {
      view.cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
    }
    resize();
    render(reducedMotion.matches ? 41_000 : view.performance.now());
    schedule();
  };
  const onVisibilityChange = (): void => {
    if (canvas.ownerDocument.visibilityState === "hidden") {
      if (animationFrame !== undefined) {
        view.cancelAnimationFrame(animationFrame);
        animationFrame = undefined;
      }
      return;
    }
    schedule();
  };
  const ResizeObserverConstructor = (
    view as Window & { ResizeObserver?: typeof ResizeObserver }
  ).ResizeObserver;
  const resizeObserver = ResizeObserverConstructor
    ? new ResizeObserverConstructor(resize)
    : undefined;
  if (resizeObserver) {
    resizeObserver.observe(canvas);
  } else {
    view.addEventListener("resize", resize);
  }
  reducedMotion.addEventListener("change", onMotionChange);
  canvas.ownerDocument.addEventListener(
    "visibilitychange",
    onVisibilityChange,
  );
  resize();
  schedule();

  return {
    setActive(nextActive: boolean): void {
      active = nextActive;
      if (!active && animationFrame !== undefined) {
        view.cancelAnimationFrame(animationFrame);
        animationFrame = undefined;
      }
      if (active) {
        resize();
        schedule();
      }
    },
    destroy(): void {
      destroyed = true;
      if (animationFrame !== undefined) {
        view.cancelAnimationFrame(animationFrame);
      }
      resizeObserver?.disconnect();
      if (!resizeObserver) {
        view.removeEventListener("resize", resize);
      }
      reducedMotion.removeEventListener("change", onMotionChange);
      canvas.ownerDocument.removeEventListener(
        "visibilitychange",
        onVisibilityChange,
      );
    },
  };
}

function supportsWebGL(document: Document): boolean {
  try {
    const probe = document.createElement("canvas");
    const context = (
      probe.getContext("webgl2") ||
        probe.getContext("webgl") ||
        probe.getContext("experimental-webgl")
    ) as WebGLRenderingContext | WebGL2RenderingContext | null;
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return Boolean(context);
  } catch {
    return false;
  }
}

function buildRibbon(
  width: number,
  height: number,
  seconds: number,
  edge: RibbonEdge,
): MeshRibbon {
  const strandCount = width < 520 ? 15 : 19;
  const segmentCount = Math.min(52, Math.max(24, Math.round(width / 20)));
  const edgePhase = edge === "top" ? 0.42 : 2.18;
  const edgeSeed = edge === "top" ? 0 : 37;
  const points: MeshPoint[][] = [];

  for (let strand = 0; strand < strandCount; strand += 1) {
    const regularRatio = strand / Math.max(1, strandCount - 1) - 0.5;
    const spacingJitter =
      (seededValue(strand + edgeSeed, 113 + edgeSeed) - 0.5) *
      0.044 *
      (1 - Math.abs(regularRatio) * 1.35);
    const strandRatio = regularRatio + spacingJitter;
    const line: MeshPoint[] = [];

    for (let segment = 0; segment < segmentCount; segment += 1) {
      const progress = segment / Math.max(1, segmentCount - 1);
      const u = -0.08 + progress * 1.16;
      const timeDirection = edge === "top" ? seconds * 0.055 : -seconds * 0.048;
      const primaryWave = Math.sin(u * 4.7 + edgePhase + timeDirection);
      const secondaryWave = Math.sin(
        u * 10.8 - edgePhase * 0.7 - timeDirection * 0.64,
      );
      const centerRatio =
        edge === "top"
          ? 0.102 + 0.064 * (1 - u) + primaryWave * 0.028 + secondaryWave * 0.011
          : 0.886 - 0.074 * u + primaryWave * 0.031 + secondaryWave * 0.013;
      const thickness =
        (edge === "top" ? 0.17 : 0.19) *
        (0.82 + 0.18 * Math.sin(u * 3.2 + edgePhase - timeDirection * 0.45));
      const weave =
        Math.sin(
          u * 11.6 + strand * 0.47 + edgePhase +
            seconds * (edge === "top" ? 0.09 : -0.075),
        ) *
        height *
        0.0048;
      const lateralDrift =
        Math.sin(u * 6.1 + strandRatio * 3.8 + timeDirection) *
        Math.min(8, width * 0.012);
      const segmentJitter =
        (seededValue(segment + edgeSeed, strand + edgeSeed + 91) - 0.5) *
        Math.min(14, width / segmentCount) *
        0.72;
      const depth =
        0.88 +
        0.12 * Math.sin(u * 5.3 - strandRatio * 2.7 + edgePhase);

      line.push({
        x: u * width + lateralDrift + segmentJitter,
        y: (centerRatio + strandRatio * thickness * depth) * height + weave,
      });
    }
    points.push(line);
  }

  return { edge, points };
}

function drawRibbon(
  context: CanvasRenderingContext2D,
  ribbon: MeshRibbon,
  seconds: number,
): void {
  const strandCount = ribbon.points.length;
  const segmentCount = ribbon.points[0]?.length ?? 0;
  const red = ribbon.edge === "top" ? 241 : 225;
  const green = ribbon.edge === "top" ? 69 : 60;
  const blue = ribbon.edge === "top" ? 103 : 92;

  context.lineWidth = 0.56;
  for (let strand = 0; strand < strandCount; strand += 1) {
    const strandFade = seededValue(
      strand + (ribbon.edge === "top" ? 13 : 71),
      19,
    );
    const alpha =
      0.075 +
      strandFade * 0.06 +
      0.04 * Math.sin(strand * 0.69 + seconds * 0.045) ** 2;
    context.strokeStyle = `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(3)})`;
    drawSmoothLine(context, ribbon.points[strand] ?? []);
  }

  context.lineWidth = 0.46;
  const connectorCount = Math.max(8, Math.round(segmentCount / 3.1));
  for (let connector = 0; connector < connectorCount; connector += 1) {
    const connectorJitter =
      (seededValue(connector + 83, ribbon.edge === "top" ? 31 : 67) -
        0.5) *
      2.4;
    const baseSegment =
      1 +
      Math.round(
        (connector / Math.max(1, connectorCount - 1)) *
          Math.max(1, segmentCount - 3) +
          connectorJitter,
      );
    const leanDirection =
      seededValue(connector + 17, ribbon.edge === "top" ? 101 : 137) > 0.5
        ? 1
        : -1;
    const connectorLean =
      leanDirection *
      (18 +
        seededValue(connector + 53, ribbon.edge === "top" ? 23 : 59) *
          34);
    const line = ribbon.points
      .map((strand, strandIndex) => {
        const point =
          strand[Math.max(0, Math.min(segmentCount - 1, baseSegment))];
        return point
          ? {
              ...point,
              x:
                point.x +
                (strandIndex / Math.max(1, strandCount - 1) - 0.5) *
                  connectorLean +
                Math.sin(strandIndex * 0.74 + connector * 1.37) * 4.2,
            }
          : undefined;
      })
      .filter((point): point is MeshPoint => point !== undefined);
    const alpha =
      0.14 +
      seededValue(connector + 29, ribbon.edge === "top" ? 7 : 43) * 0.1;
    context.strokeStyle = `rgba(214, 72, 102, ${alpha.toFixed(3)})`;
    drawSmoothLine(context, line);
  }

  context.lineWidth = 0.4;
  context.strokeStyle = "rgba(224, 76, 106, 0.16)";
  for (let strand = 0; strand < strandCount - 1; strand += 1) {
    for (let segment = 1; segment < segmentCount - 2; segment += 2) {
      if (
        seededValue(
          segment + strand * 3,
          strand + (ribbon.edge === "top" ? 11 : 61),
        ) < 0.73
      ) {
        continue;
      }
      const point = ribbon.points[strand]?.[segment];
      const direction =
        seededValue(segment + 5, strand + 17) > 0.5 ? 1 : -1;
      const diagonal =
        ribbon.points[strand + 1]?.[
          Math.max(0, Math.min(segmentCount - 1, segment + direction))
        ];
      if (!point || !diagonal) {
        continue;
      }
      context.beginPath();
      context.moveTo(point.x, point.y);
      context.quadraticCurveTo(
        (point.x + diagonal.x) / 2 + direction * 2.4,
        (point.y + diagonal.y) / 2,
        diagonal.x,
        diagonal.y,
      );
      context.stroke();
    }
  }

}

function drawSmoothLine(
  context: CanvasRenderingContext2D,
  points: MeshPoint[],
): void {
  const first = points[0];
  if (!first) {
    return;
  }
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    if (!point || !next) {
      continue;
    }
    context.quadraticCurveTo(
      point.x,
      point.y,
      (point.x + next.x) / 2,
      (point.y + next.y) / 2,
    );
  }
  const last = points.at(-1);
  if (last) {
    context.lineTo(last.x, last.y);
  }
  context.stroke();
}

function seededValue(column: number, row: number): number {
  const value = Math.sin(column * 91.731 + row * 47.217) * 43_758.5453;
  return value - Math.floor(value);
}
