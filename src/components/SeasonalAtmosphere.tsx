"use client";

// Ambient page-wide atmosphere, tied to whichever seasonal theme is actually
// leading right now (src/lib/seasonal.ts), not a generic calendar effect.
// Restraint is the point: most themes render nothing at all (see
// themeAtmosphere) rather than every season getting a gimmick.
//
// DOM-based (not canvas): each particle is a real, styleable element so it
// can be recolored per-instance, rotated/scaled via CSS transform, and
// layered in front of OR behind page content via z-index — a canvas is one
// flat bitmap and can't do any of that.
// Two depth layers per variant: BACK sits at a negative z-index so it paints
// behind normal in-flow content (card tiles, images) but above the plain
// background; FRONT sits below the sticky header (z-40) but above content,
// for the "closer" leaves. Bigger/faster in front, smaller/slower behind.
import { useEffect, useRef } from "react";

export type AtmosphereVariant = "leaves" | "snow" | "petals" | "none";

// A real (extracted-from-PSD) photographed maple leaf with its own vein
// texture — public/leaves/maple-leaf.png, 515x640, real alpha. Aspect ratio
// baked in below so sizing stays correct without re-measuring at runtime.
const LEAF_IMG_SRC = "/leaves/maple-leaf.png";
const LEAF_ASPECT = 515 / 640; // width / height

// The source photo is grayscale, so color comes from CSS filters rather
// than a flat tint — sepia() first (grayscale has no hue for hue-rotate to
// act on), then hue-rotate() dials the resulting brown around the wheel,
// saturate()/brightness() push it toward gold, orange, red, or a darker
// brown. This keeps the photo's own vein/shading detail instead of
// flattening it the way a solid-color mask would.
const LEAF_FILTERS = [
  "sepia(1) saturate(6) hue-rotate(8deg) brightness(1.15) contrast(1.05)", // gold
  "sepia(1) saturate(6) hue-rotate(-6deg) brightness(0.95) contrast(1.05)", // orange
  "sepia(1) saturate(6) hue-rotate(-6deg) brightness(0.95) contrast(1.05)",
  "sepia(1) saturate(7) hue-rotate(-25deg) brightness(0.85) contrast(1.1)", // red
  "sepia(1) saturate(7) hue-rotate(-25deg) brightness(0.85) contrast(1.1)",
  "sepia(1) saturate(5) hue-rotate(-15deg) brightness(0.75) contrast(1.05)", // burnt orange
  "sepia(0.8) saturate(2.5) hue-rotate(-5deg) brightness(0.55) contrast(1.1)", // brown
];
const SNOW_COLOR = "#ffffff";
const PETAL_COLORS = ["#f3c9d6", "#eab8c8", "#f7dde5"];

type Shape = "leaf" | "circle" | "ellipse";

type LayerSpec = {
  count: number;
  size: [number, number];
  speed: [number, number];
  opacity: [number, number];
  sway: [number, number];
};

type VariantSpec = {
  shape: Shape;
  colors: string[];
  back: LayerSpec;
  front: LayerSpec;
};

const VARIANTS: Record<Exclude<AtmosphereVariant, "none">, VariantSpec> = {
  leaves: {
    shape: "leaf",
    colors: LEAF_FILTERS,
    back: { count: 32, size: [13, 19], speed: [9, 15], opacity: [0.24, 0.4], sway: [18, 28] },
    front: { count: 14, size: [21, 30], speed: [14, 22], opacity: [0.38, 0.58], sway: [26, 38] },
  },
  snow: {
    shape: "circle",
    colors: [SNOW_COLOR],
    back: { count: 44, size: [2, 4], speed: [10, 18], opacity: [0.28, 0.5], sway: [8, 14] },
    front: { count: 20, size: [4, 7], speed: [18, 28], opacity: [0.5, 0.8], sway: [10, 16] },
  },
  petals: {
    shape: "ellipse",
    colors: PETAL_COLORS,
    back: { count: 22, size: [8, 12], speed: [8, 13], opacity: [0.3, 0.5], sway: [16, 26] },
    front: { count: 12, size: [14, 20], speed: [13, 20], opacity: [0.5, 0.8], sway: [22, 34] },
  },
};

type Particle = {
  el: HTMLDivElement;
  x: number;
  y: number;
  vy: number;
  size: number;
  rotation: number;
  rotSpeed: number;
  swayPhase: number;
  swaySpeed: number;
  swayAmp: number;
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);

function makeParticleEl(shape: Shape, colorOrFilter: string, size: number, opacity: number): HTMLDivElement {
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.left = "0";
  el.style.top = "0";
  el.style.opacity = String(opacity);
  el.style.willChange = "transform";
  if (shape === "leaf") {
    el.style.width = `${size * LEAF_ASPECT}px`;
    el.style.height = `${size}px`;
    const img = document.createElement("img");
    img.src = LEAF_IMG_SRC;
    img.alt = "";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.filter = colorOrFilter;
    img.draggable = false;
    el.appendChild(img);
  } else if (shape === "circle") {
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.borderRadius = "50%";
    el.style.background = colorOrFilter;
  } else {
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.borderRadius = "50%";
    el.style.background = colorOrFilter;
    el.style.transform = "scaleY(0.6)";
  }
  return el;
}

function spawnLayer(
  container: HTMLDivElement,
  spec: LayerSpec,
  shape: Shape,
  colors: string[],
  w: number,
  h: number,
): Particle[] {
  const particles: Particle[] = [];
  for (let i = 0; i < spec.count; i++) {
    const size = rand(...spec.size);
    const opacity = rand(...spec.opacity);
    const color = colors[Math.floor(Math.random() * colors.length)];
    const el = makeParticleEl(shape, color, size, opacity);
    container.appendChild(el);
    particles.push({
      el,
      x: Math.random() * w,
      y: Math.random() * h,
      vy: rand(...spec.speed),
      size,
      rotation: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * (shape === "circle" ? 20 : 70),
      swayPhase: Math.random() * Math.PI * 2,
      swaySpeed: rand(0.3, 0.8),
      swayAmp: rand(...spec.sway),
    });
  }
  return particles;
}

function AtmosphereLayer({
  variant,
  layer,
  fixedClassName,
}: {
  variant: AtmosphereVariant;
  layer: "back" | "front";
  fixedClassName: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (variant === "none") return;
    const container = containerRef.current;
    if (!container) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const spec = VARIANTS[variant];
    const layerSpec = layer === "back" ? spec.back : spec.front;

    let w = window.innerWidth;
    let h = window.innerHeight;
    let particles = spawnLayer(container, layerSpec, spec.shape, spec.colors, w, h);
    let raf = 0;
    let last = performance.now();
    let running = true;

    const onResize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
    };
    window.addEventListener("resize", onResize);

    const tick = (now: number) => {
      if (!running) return;
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      for (const p of particles) {
        p.y += p.vy * dt;
        p.swayPhase += p.swaySpeed * dt;
        p.x += Math.sin(p.swayPhase) * p.swayAmp * dt * 0.6;
        p.rotation += p.rotSpeed * dt;
        if (p.y - p.size > h) {
          p.y = -p.size;
          p.x = Math.random() * w;
        }
        if (p.x < -30) p.x = w + 30;
        if (p.x > w + 30) p.x = -30;
        p.el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0) rotate(${p.rotation}deg)`;
      }
      raf = requestAnimationFrame(tick);
    };

    const onVisibility = () => {
      running = document.visibilityState === "visible";
      if (running) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      } else {
        cancelAnimationFrame(raf);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    raf = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      container.replaceChildren();
      particles = [];
    };
  }, [variant, layer]);

  if (variant === "none") return null;
  return <div ref={containerRef} aria-hidden="true" className={fixedClassName} />;
}

function Twinkles() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const w = window.innerWidth;
    const h = window.innerHeight * 0.7;
    const nodes: HTMLDivElement[] = [];
    for (let i = 0; i < 16; i++) {
      const el = document.createElement("div");
      const size = rand(1.5, 3.2);
      el.style.position = "absolute";
      el.style.left = `${Math.random() * w}px`;
      el.style.top = `${Math.random() * h}px`;
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.borderRadius = "50%";
      el.style.background = "#e9c388";
      el.style.boxShadow = "0 0 6px 1px #e9c38888";
      el.style.animation = `atmosphere-twinkle ${rand(2, 4)}s ease-in-out ${rand(0, 3)}s infinite`;
      container.appendChild(el);
      nodes.push(el);
    }
    return () => container.replaceChildren();
  }, []);

  return <div ref={containerRef} aria-hidden="true" className="pointer-events-none fixed inset-0 z-20" />;
}

export function SeasonalAtmosphere({
  variant,
  twinkle = false,
}: {
  variant: AtmosphereVariant;
  twinkle?: boolean;
}) {
  return (
    <>
      <AtmosphereLayer
        key={`back-${variant}`}
        variant={variant}
        layer="back"
        fixedClassName="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      />
      <AtmosphereLayer
        key={`front-${variant}`}
        variant={variant}
        layer="front"
        fixedClassName="pointer-events-none fixed inset-0 z-20 overflow-hidden"
      />
      {twinkle && <Twinkles />}
    </>
  );
}

export default SeasonalAtmosphere;
