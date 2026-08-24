// Static, very low-opacity texture behind everything else — a treeline
// silhouette along the bottom edge and a faint warm wash up top — so the
// plain parchment background reads as "a place," not a flat color. No
// animation here on purpose: this is texture, the falling particles in
// SeasonalAtmosphere carry the motion.
export function ForestBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-20 overflow-hidden">
      <div
        className="absolute inset-0 opacity-[0.07]"
        style={{
          background: "radial-gradient(ellipse 80% 50% at 50% -10%, var(--brass-glow), transparent 60%)",
        }}
      />
      <svg
        className="absolute inset-x-0 bottom-0 h-40 w-full opacity-[0.05]"
        preserveAspectRatio="xMidYMax slice"
      >
        <defs>
          <pattern id="forest-treeline" width="110" height="180" patternUnits="userSpaceOnUse">
            <polygon points="55,10 100,180 10,180" fill="var(--sage)" />
            <polygon points="18,55 55,180 -19,180" fill="var(--brass)" />
            <polygon points="92,45 129,180 55,180" fill="var(--brass)" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#forest-treeline)" />
      </svg>
    </div>
  );
}

export default ForestBackdrop;
