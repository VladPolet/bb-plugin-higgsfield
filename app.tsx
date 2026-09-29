// bb-plugin-higgsfield — the Higgsfield credits dashboard page.
//
// The server's `dashboard` RPC returns every loaded transaction plus the
// detected billing cycle and forecast; range-dependent numbers are computed
// here with the same `summarize()` the CLI uses. The page refetches on the
// "higgsfield-changed" realtime signal (sign-in or settings change).
//
// Color: one categorical palette (validated for CVD in light and dark, see
// PALETTE) encodes whichever dimension "Color by" selects — model or media
// type — across every chart and table on the page, so a hue never means two
// things at once. Status colors are reserved for job state and the forecast
// verdict, and always ship with an icon and a label.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  experimental_useCodeTheme,
  UrlLink,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { Dashboard, rpcContract } from "./server";
import {
  dailyBalance,
  summarize,
  type Media,
  type ModelStat,
  type Summary,
  type Transaction,
} from "./normalize";
import { Button } from "@/components/ui/button";
import { Icon, LUCIDE } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

// ----------------------------------------------------------------- palette

/**
 * Categorical slots in fixed order (dataviz reference palette; validated with
 * validate_palette.js: adjacent CVD ΔE ≥ 9.1 light / 8.4 dark). Slot 8 (red)
 * is left out so it never reads as the "failed" status.
 */
const PALETTE = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"],
};
const OTHER = { light: "#b5b3ab", dark: "#5c5b56" };
const STATUS = { good: "#0ca30c", warning: "#fab219", critical: "#d03b3b" };
const SUCCESS_TEXT = { light: "#006300", dark: "#0ca30c" };

const MEDIA: Record<Media, { label: string; icon: string; slot: number }> = {
  image: { label: "Image", icon: "Image", slot: 0 },
  video: { label: "Video", icon: "Video", slot: 1 },
  audio: { label: "Audio", icon: "Music", slot: 2 },
  text: { label: "Text", icon: "Type", slot: 3 },
};
const MEDIA_ORDER: readonly Media[] = ["image", "video", "audio", "text"];

type ColorBy = "model" | "media";
type Series = { key: string; label: string; color: string; icon?: string };

function usePalette() {
  const mode = experimental_useCodeTheme().mode;
  return useMemo(() => {
    const slots = PALETTE[mode];
    return {
      mode,
      slot: (index: number | undefined) =>
        index === undefined ? OTHER[mode] : (slots[index] ?? OTHER[mode]),
      other: OTHER[mode],
      success: SUCCESS_TEXT[mode],
    };
  }, [mode]);
}
type Palette = ReturnType<typeof usePalette>;

/** Resolve the series a model belongs to under the active "Color by". */
function seriesOf(
  stat: { label: string; media: Media | null },
  colorBy: ColorBy,
  slots: Dashboard["slots"],
  palette: Palette,
): Series {
  if (colorBy === "media") {
    if (stat.media === null) return { key: "unknown", label: "Other", color: palette.other };
    const media = MEDIA[stat.media];
    return { key: stat.media, label: media.label, color: palette.slot(media.slot), icon: media.icon };
  }
  const slot = slots[stat.label];
  return slot === undefined
    ? { key: "__other", label: "Other models", color: palette.other }
    : { key: stat.label, label: stat.label, color: palette.slot(slot) };
}

/** Legend order: slot order (stable), "Other" last. */
function seriesList(
  models: readonly ModelStat[],
  colorBy: ColorBy,
  slots: Dashboard["slots"],
  palette: Palette,
): Series[] {
  if (colorBy === "media") {
    const present = new Set(models.map((m) => m.media));
    const list: Series[] = MEDIA_ORDER.filter((m) => present.has(m)).map((m) => ({
      key: m,
      label: MEDIA[m].label,
      color: palette.slot(MEDIA[m].slot),
      icon: MEDIA[m].icon,
    }));
    if (present.has(null)) list.push({ key: "unknown", label: "Other", color: palette.other });
    return list;
  }
  const colored = Object.entries(slots)
    .filter(([label]) => models.some((m) => m.label === label))
    .sort((a, b) => a[1] - b[1])
    .map(([label, slot]) => ({ key: label, label, color: palette.slot(slot) }));
  if (models.some((m) => slots[m.label] === undefined)) {
    colored.push({ key: "__other", label: "Other models", color: palette.other });
  }
  return colored;
}

// ------------------------------------------------------------------ format

const fmt = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined
    ? "—"
    : value.toLocaleString(undefined, { maximumFractionDigits: digits });
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const dayLabel = (key: string) => shortDate(`${key}T12:00:00`);
const dateTime = (iso: string | null) =>
  iso === null
    ? "—"
    : new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
const relative = (iso: string | null) => {
  if (iso === null) return "—";
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (hours < 1) return "just now";
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};
const plural = (n: number, word: string) => `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;

// -------------------------------------------------------------------- data

function useDashboard() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(
    (force: boolean) => {
      setLoading(true);
      rpc
        .call("dashboard", { force })
        .then(
          (result) => {
            setData(result);
            setError(null);
          },
          (cause: unknown) =>
            setError(cause instanceof Error ? cause.message : String(cause)),
        )
        .finally(() => setLoading(false));
    },
    [rpc],
  );
  useEffect(() => load(false), [load]);
  useRealtime("higgsfield-changed", () => load(false));
  return { rpc, data, error, loading, load };
}

type RangeKey = "cycle" | "7d" | "30d" | "90d";
const RANGES: { key: RangeKey; label: string }[] = [
  { key: "cycle", label: "This cycle" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
];

function rangeStart(key: RangeKey, cycle: Dashboard["cycle"]): Date {
  const now = Date.now();
  const days = { cycle: 30, "7d": 7, "30d": 30, "90d": 90 }[key];
  if (key === "cycle" && cycle !== null) return new Date(cycle.startedAt);
  // Whole days: start at local midnight so the first bar is a full day.
  const start = new Date(now - (days - 1) * 86_400_000);
  start.setHours(0, 0, 0, 0);
  return start;
}

// ------------------------------------------------------------------ pieces

function Section({
  title,
  aside,
  children,
  className,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-border bg-card p-4", className)}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {aside === undefined ? null : (
          <span className="text-xs text-muted-foreground">{aside}</span>
        )}
      </div>
      {children}
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  icon,
  children,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  icon: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon name={icon} className="size-3.5" />
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {sub === undefined ? null : (
        <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
      )}
      {children}
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function Swatch({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2.5 shrink-0 rounded-[3px]", className)}
      style={{ backgroundColor: color }}
    />
  );
}

/** Media-type tag: icon + label in neutral ink (hue belongs to "Color by"). */
function MediaTag({ media }: { media: Media | null }) {
  if (media === null) return null;
  const info = MEDIA[media];
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-px text-[11px] text-muted-foreground">
      <Icon name={info.icon} className="size-3" />
      {info.label}
    </span>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { key: T; label: string }[];
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-border p-0.5">
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          role="radio"
          aria-checked={value === option.key}
          onClick={() => onChange(option.key)}
          className={cn(
            "rounded px-2.5 py-1 text-xs transition-colors",
            value === option.key
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <Swatch color={s.color} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- forecast

const VERDICT = {
  "runs-out": { color: STATUS.critical, icon: "CircleAlert", tag: "Runs out before reset" },
  "will-expire": { color: STATUS.warning, icon: "Hourglass", tag: "Credits will expire" },
  "on-track": { color: STATUS.good, icon: "CircleCheck", tag: "On track" },
  idle: { color: STATUS.good, icon: "CircleCheck", tag: "No spend yet" },
  unknown: { color: STATUS.warning, icon: "CircleHelp", tag: "Reset date unknown" },
} as const;

const DAY_MS = 86_400_000;

/** Big number + one short line: the forecast's answer, nothing else. */
function ForecastHeadline({ data }: { data: Dashboard }) {
  const f = data.forecast;
  const c = data.cycle;
  const reset = c === null ? "" : shortDate(c.nextResetAt);
  const [big, caption]: [string, string] = (() => {
    switch (f.verdict) {
      case "will-expire":
        return [`~${fmt(f.leftAtReset)}`, `credits will expire unused on ${reset}`];
      case "runs-out": {
        const early = c === null || f.runwayDays === null ? 0 : Math.ceil(c.daysToReset - f.runwayDays);
        return [
          f.runsOutAt === null ? "—" : shortDate(f.runsOutAt),
          `balance runs out, ${plural(early, "day")} before the reset`,
        ];
      }
      case "on-track":
        return [`~${fmt(f.leftAtReset)}`, `credits left on ${reset}: you'll use nearly everything`];
      case "idle":
        return ["0", "credits spent this cycle so far"];
      case "unknown":
        return ["?", "no monthly grant found in history"];
    }
  })();
  return (
    <div className="flex items-end gap-3">
      <span className="text-4xl font-semibold leading-none tracking-tight">{big}</span>
      <span className="pb-0.5 text-sm text-muted-foreground">
        {caption}
        {f.verdict === "will-expire" || f.verdict === "runs-out" || f.verdict === "on-track"
          ? ` at ${fmt(f.burnCycle, 1)}/day`
          : ""}
      </span>
    </div>
  );
}

/**
 * The cycle as one picture: actual balance from the grant to today (solid),
 * projected balance at the current burn to the reset (dashed), and where it
 * lands. Balance is rebuilt from transactions, so it is complete from day one.
 */
function CycleProjection({ data, palette }: { data: Dashboard; palette: Palette }) {
  const c = data.cycle;
  const f = data.forecast;
  const credits = data.account?.credits ?? null;
  const [hover, setHover] = useState<number | null>(null);
  const model = useMemo(() => {
    if (c === null || credits === null) return null;
    const start = Date.parse(c.startedAt);
    const end = Date.parse(c.nextResetAt);
    const now = Date.now();
    const actual = dailyBalance(data.transactions, credits, new Date(start), new Date(now)).map(
      (point, index, all) => ({
        t: index === 0 ? start : index === all.length - 1 ? now : Date.parse(`${point.date}T23:59:59`),
        v: point.credits,
      }),
    );
    // Projection: straight line at the cycle burn, clamped at zero.
    const zeroAt = f.burnCycle > 0 ? now + (credits / f.burnCycle) * DAY_MS : Infinity;
    const projected =
      zeroAt < end
        ? [{ t: now, v: credits }, { t: zeroAt, v: 0 }, { t: end, v: 0 }]
        : [{ t: now, v: credits }, { t: end, v: Math.max(0, credits - f.burnCycle * ((end - now) / DAY_MS)) }];
    const top = Math.max(1, ...actual.map((p) => p.v), credits) * 1.12;
    const x = (t: number) => ((t - start) / (end - start)) * 100;
    const y = (v: number) => 100 - (v / top) * 100;
    const path = (points: { t: number; v: number }[]) =>
      points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t)},${y(p.v)}`).join(" ");
    const area = `${path(actual)} L${x(now)},100 L${x(start)},100 Z`;
    return { start, end, now, actual, projected, zeroAt, x, y, path, area, top };
  }, [c, credits, data.transactions, f.burnCycle]);
  if (model === null || c === null || credits === null) return null;

  const blue = palette.slot(0);
  const endPoint = model.projected.at(-1) ?? { t: model.end, v: 0 };
  const landsAtZero = model.zeroAt < model.end;
  const markerColor = VERDICT[f.verdict].color;
  const valueAt = (t: number) => {
    if (t <= model.now) {
      let best = model.actual[0];
      for (const p of model.actual) if (Math.abs(p.t - t) < Math.abs((best?.t ?? 0) - t)) best = p;
      return { t: best?.t ?? t, v: best?.v ?? 0, projected: false };
    }
    const [a, b, d] = model.projected;
    const segs = [a, b, d].filter((p): p is { t: number; v: number } => p !== undefined);
    for (let i = 1; i < segs.length; i += 1) {
      const p0 = segs[i - 1];
      const p1 = segs[i];
      if (p0 !== undefined && p1 !== undefined && t <= p1.t) {
        const k = p1.t === p0.t ? 0 : (t - p0.t) / (p1.t - p0.t);
        return { t, v: p0.v + (p1.v - p0.v) * k, projected: true };
      }
    }
    return { t, v: endPoint.v, projected: true };
  };
  const hovered = hover === null ? null : valueAt(hover);
  const dot = (t: number, v: number, color: string, ring = true) => (
    <span
      className={cn("absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full", ring && "ring-2 ring-card")}
      style={{ left: `${model.x(t)}%`, top: `${model.y(v)}%`, backgroundColor: color }}
    />
  );
  return (
    <div>
      <div className="mb-2 flex h-4 items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full" style={{ backgroundColor: blue }} />
            Balance
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-4 border-t-2 border-dashed" style={{ borderColor: blue }} />
            Projected at {fmt(f.burnCycle, 1)}/day
          </span>
        </span>
        <span className="tabular-nums">
          {hovered === null
            ? null
            : `${shortDate(new Date(hovered.t).toISOString())} · ${hovered.projected ? "~" : ""}${fmt(hovered.v)} credits`}
        </span>
      </div>
      <div
        className="relative h-44"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const k = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
          setHover(model.start + k * (model.end - model.start));
        }}
        role="img"
        aria-label={`Balance this cycle and projection to the reset on ${shortDate(c.nextResetAt)}`}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
          <line x1={0} x2={100} y1={100} y2={100} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <path d={model.area} fill={blue} fillOpacity={0.1} />
          <path d={model.path(model.actual)} fill="none" stroke={blue} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          <path
            d={model.path(model.projected)}
            fill="none"
            stroke={blue}
            strokeWidth={2}
            strokeDasharray="5 5"
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1={model.x(model.now)}
            x2={model.x(model.now)}
            y1={0}
            y2={100}
            className="stroke-muted-foreground"
            strokeWidth={1}
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
          />
          {hovered === null ? null : (
            <line
              x1={model.x(hovered.t)}
              x2={model.x(hovered.t)}
              y1={0}
              y2={100}
              className="stroke-foreground/30"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {/* Labels live in HTML so the stretched SVG never distorts text. */}
        {/* Right of the dot, above the dashed projection. */}
        <span
          className="absolute -translate-y-full whitespace-nowrap pb-1.5 pl-2.5 text-xs"
          style={{ left: `${model.x(model.now)}%`, top: `${model.y(credits)}%` }}
        >
          <span className="text-muted-foreground">Today </span>
          <span className="font-medium tabular-nums">{fmt(credits)}</span>
        </span>
        {dot(model.now, credits, blue)}
        {landsAtZero ? dot(model.zeroAt, 0, STATUS.critical) : null}
        {dot(endPoint.t, endPoint.v, markerColor)}
        <span
          className="absolute -translate-x-full -translate-y-full whitespace-nowrap pb-2 pr-1 text-xs font-medium"
          style={{
            left: `${model.x(landsAtZero ? model.zeroAt : endPoint.t)}%`,
            top: `${model.y(landsAtZero ? 0 : endPoint.v)}%`,
            color: markerColor,
          }}
        >
          {landsAtZero
            ? `0 on ${shortDate(new Date(model.zeroAt).toISOString())}`
            : `~${fmt(endPoint.v)} left`}
        </span>
        {hovered === null ? null : dot(hovered.t, hovered.v, blue)}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
        <span>Grant {shortDate(c.startedAt)} · +{fmt(c.grantAmount)}</span>
        <span>
          Day {fmt(Math.floor(c.daysElapsed) + 1)} of {fmt(Math.round(c.cycleDays))}
        </span>
        <span>Reset {shortDate(c.nextResetAt)}</span>
      </div>
    </div>
  );
}

/** Bullet chart: actual burn per window vs. the pace that spends everything. */
function PaceBlock({ data, palette }: { data: Dashboard; palette: Palette }) {
  const f = data.forecast;
  const rows = [
    { label: "This cycle", value: f.burnCycle },
    { label: "Last 7 days", value: f.burn7d },
  ];
  const needed = f.paceToUseAll;
  const max = Math.max(1, ...rows.map((r) => r.value), needed ?? 0) * 1.1;
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs font-medium">Burn rate</div>
      <div className="relative mt-3 space-y-2.5">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[5.5rem_1fr_4.5rem] items-center gap-2 text-xs">
            <span className="text-muted-foreground">{row.label}</span>
            <div className="h-2.5 rounded-[3px] bg-muted">
              <div
                className="h-full rounded-[3px]"
                style={{ width: `${(row.value / max) * 100}%`, backgroundColor: palette.slot(0) }}
              />
            </div>
            <span className="text-right font-medium tabular-nums">{fmt(row.value, 1)}/day</span>
          </div>
        ))}
        {needed === null ? null : (
          // The target tick spans both bars, inside the bar column.
          <div className="pointer-events-none absolute inset-y-[-4px] left-[calc(5.5rem+0.5rem)] right-[calc(4.5rem+0.5rem)]">
            <div
              className="absolute inset-y-0 w-0 border-l-2 border-dashed border-foreground/70"
              style={{ left: `${(needed / max) * 100}%` }}
            />
          </div>
        )}
      </div>
      {needed === null ? null : (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-3 w-0 border-l-2 border-dashed border-foreground/70" />
          <span>
            <span className="font-medium text-foreground">{fmt(needed, 1)}/day</span> spends the whole balance by the reset
          </span>
        </div>
      )}
    </div>
  );
}

/** Share of the monthly grant: used this cycle, and what expired last time. */
function GrantBlock({ data, palette }: { data: Dashboard; palette: Palette }) {
  const c = data.cycle;
  if (c === null) return null;
  const last = c.previous.find((p) => p.expired !== null) ?? null;
  const bar = (parts: { value: number; color: string; title: string }[], total: number) => (
    <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-[3px] bg-muted">
      {parts
        .filter((part) => part.value > 0)
        .map((part) => (
          <div
            key={part.title}
            title={part.title}
            style={{ width: `${Math.min(100, (part.value / Math.max(1, total)) * 100)}%`, backgroundColor: part.color }}
          />
        ))}
    </div>
  );
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs font-medium">Monthly grant · {fmt(c.grantAmount)} credits</div>
      <div className="mt-3 space-y-3 text-xs">
        <div>
          <div className="mb-1 flex justify-between">
            <span className="text-muted-foreground">This cycle, used so far</span>
            <span className="tabular-nums">
              <span className="font-medium">{fmt(c.spentThisCycle)}</span>
              <span className="text-muted-foreground"> · {fmt((c.spentThisCycle / Math.max(1, c.grantAmount)) * 100)}%</span>
            </span>
          </div>
          {bar([{ value: c.spentThisCycle, color: palette.slot(0), title: "Used" }], c.grantAmount)}
        </div>
        {last === null ? null : (
          <div>
            <div className="mb-1 flex justify-between">
              <span className="text-muted-foreground">Last cycle, expired unused</span>
              <span className="tabular-nums">
                <span className="font-medium" style={{ color: STATUS.warning }}>
                  {fmt(last.expired)}
                </span>
                <span className="text-muted-foreground"> · {fmt(((last.expired ?? 0) / Math.max(1, last.granted)) * 100)}%</span>
              </span>
            </div>
            {bar(
              [
                { value: last.granted - (last.expired ?? 0), color: palette.slot(0), title: "Used" },
                { value: last.expired ?? 0, color: STATUS.warning, title: "Expired" },
              ],
              last.granted,
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ForecastCard({ data }: { data: Dashboard }) {
  const palette = usePalette();
  const v = VERDICT[data.forecast.verdict];
  return (
    <section
      className="rounded-lg border border-border bg-card p-4"
      style={{ borderLeftColor: v.color, borderLeftWidth: 3 }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Burn forecast</h2>
        <span
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
          style={{ color: v.color, backgroundColor: `${v.color}1f` }}
        >
          <Icon name={v.icon} className="size-3.5" />
          {v.tag}
        </span>
      </div>
      <div className="mt-3">
        <ForecastHeadline data={data} />
      </div>
      <div className="mt-5">
        <CycleProjection data={data} palette={palette} />
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-2">
        <PaceBlock data={data} palette={palette} />
        <GrantBlock data={data} palette={palette} />
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ charts

/** Credits spent per day, stacked by the active series (2px surface gaps). */
function DailyBars({
  summary,
  series,
  resolve,
}: {
  summary: Summary;
  series: Series[];
  resolve: (label: string) => Series;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const days = useMemo(
    () =>
      summary.daily.map((point) => {
        const totals = new Map<string, number>();
        for (const [label, value] of Object.entries(point.byLabel)) {
          const key = resolve(label).key;
          totals.set(key, (totals.get(key) ?? 0) + value);
        }
        return { date: point.date, spent: point.spent, totals };
      }),
    [summary, resolve],
  );
  const max = Math.max(1, ...days.map((d) => d.spent));
  const active = hover === null ? null : days[hover];
  return (
    <div>
      <div className="mb-2 min-h-8 text-xs text-muted-foreground">
        {active === null || active === undefined ? (
          <span>
            Peak {fmt(Math.max(0, ...days.map((d) => d.spent)), 1)} credits/day · hover a bar for details
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="font-medium text-foreground">
              {dayLabel(active.date)} · {fmt(active.spent, 1)} credits
            </span>
            {series
              .filter((s) => (active.totals.get(s.key) ?? 0) > 0)
              .map((s) => (
                <span key={s.key} className="flex items-center gap-1 tabular-nums">
                  <Swatch color={s.color} className="size-2" />
                  {s.label} {fmt(active.totals.get(s.key), 1)}
                </span>
              ))}
          </div>
        )}
      </div>
      <div
        className="flex h-40 items-end gap-[2px] border-b border-border"
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="Credits spent per day"
      >
        {days.map((day, index) => (
          <div
            key={day.date}
            className="flex h-full min-w-0 flex-1 cursor-default flex-col justify-end"
            onMouseEnter={() => setHover(index)}
          >
            <div
              className={cn(
                "flex w-full flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px] transition-opacity",
                hover !== null && hover !== index && "opacity-40",
              )}
              style={{ height: day.spent <= 0 ? 0 : `${Math.max(2, (day.spent / max) * 100)}%` }}
            >
              {series.map((s) => {
                const value = day.totals.get(s.key) ?? 0;
                if (value <= 0) return null;
                return (
                  <div
                    key={s.key}
                    className="w-full shrink-0"
                    style={{ flexGrow: value, flexBasis: 0, minHeight: 1, backgroundColor: s.color }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
        <span>{days[0] === undefined ? "" : dayLabel(days[0].date)}</span>
        <span>Today</span>
      </div>
    </div>
  );
}

/** Share of credits per series: one 100% strip plus the ranked list. */
function Breakdown({
  models,
  series,
  resolve,
}: {
  models: ModelStat[];
  series: Series[];
  resolve: (label: string) => Series;
}) {
  const totals = new Map<string, { spent: number; generations: number }>();
  for (const m of models) {
    const key = resolve(m.label).key;
    const entry = totals.get(key) ?? { spent: 0, generations: 0 };
    entry.spent += m.spent;
    entry.generations += m.generations;
    totals.set(key, entry);
  }
  const rows = series
    .map((s) => ({ ...s, ...(totals.get(s.key) ?? { spent: 0, generations: 0 }) }))
    .filter((row) => row.spent > 0)
    .sort((a, b) => b.spent - a.spent);
  const total = rows.reduce((sum, row) => sum + row.spent, 0);
  if (rows.length === 0 || total <= 0) return <EmptyState>No spending in this range.</EmptyState>;
  return (
    <div>
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-[4px]" role="img" aria-label="Share of credits">
        {rows.map((row) => (
          <div
            key={row.key}
            title={`${row.label}: ${fmt(row.spent, 1)}`}
            style={{ flexGrow: row.spent, flexBasis: 0, backgroundColor: row.color }}
          />
        ))}
      </div>
      <ul className="mt-3 space-y-1.5">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2 text-sm">
            <Swatch color={row.color} />
            {row.icon === undefined ? null : (
              <Icon name={row.icon} className="size-3.5 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {plural(row.generations, "gen")}
            </span>
            <span className="w-16 shrink-0 text-right tabular-nums">{fmt(row.spent, 1)}</span>
            <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {Math.round((row.spent / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ tables

function Table({
  head,
  rows,
  align,
}: {
  head: string[];
  rows: { key: string; cells: ReactNode[] }[];
  /** Columns (by index) that hold numbers: right-aligned, tabular figures. */
  align?: number[];
}) {
  const numeric = new Set(align ?? [head.length - 1]);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            {head.map((cell, index) => (
              <th
                key={cell}
                className={cn("pb-2 pr-3 font-normal last:pr-0", numeric.has(index) && "text-right")}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.key}>
              {row.cells.map((cell, index) => (
                <td
                  key={index}
                  className={cn(
                    "py-1.5 pr-3 align-middle last:pr-0",
                    numeric.has(index) && "text-right tabular-nums",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Every model in the range: generations, failures, credits, cost per generation. */
function ModelTable({
  summary,
  resolve,
}: {
  summary: Summary;
  resolve: (label: string) => Series;
}) {
  if (summary.models.length === 0) return <EmptyState>No generations in this range.</EmptyState>;
  const max = Math.max(1, ...summary.models.map((m) => m.spent));
  return (
    <Table
      head={["Model", "Type", "Generations", "Failed", "Credits", "Per gen", "Share", "Last used"]}
      align={[2, 3, 4, 5]}
      rows={summary.models.map((m) => {
        const s = resolve(m.label);
        return {
          key: m.label,
          cells: [
            <span className="flex min-w-0 items-center gap-2">
              <Swatch color={s.color} />
              <span className="truncate">{m.label}</span>
            </span>,
            <MediaTag media={m.media} />,
            fmt(m.generations),
            m.refunds === 0 ? (
              <span className="text-muted-foreground">0</span>
            ) : (
              <span title="Failed generations whose credits were refunded">{fmt(m.refunds)}</span>
            ),
            fmt(m.spent, 1),
            <span className="text-muted-foreground">{fmt(m.avgPerGeneration, 2)}</span>,
            <div className="h-1.5 w-20 rounded-full bg-muted" title={`${fmt((m.spent / Math.max(1, summary.spent)) * 100)}%`}>
              <div
                className="h-full rounded-full"
                style={{ width: `${(Math.max(0, m.spent) / max) * 100}%`, backgroundColor: s.color }}
              />
            </div>,
            <span className="whitespace-nowrap text-muted-foreground">{relative(m.lastAt)}</span>,
          ],
        };
      })}
    />
  );
}

const CATEGORY: Record<Transaction["category"], { label: string; icon: string }> = {
  spend: { label: "Generation", icon: "Sparkles" },
  refund: { label: "Refund", icon: "Undo2" },
  subscription: { label: "Subscription", icon: "CalendarSync" },
  package: { label: "Credit package", icon: "PackagePlus" },
  expiry: { label: "Expired", icon: "Hourglass" },
};

function jobStatus(status: string): { color: string; icon: string } {
  if (/complete|success|done|finished/i.test(status)) return { color: STATUS.good, icon: "CircleCheck" };
  if (/fail|error|nsfw|cancel|reject/i.test(status)) return { color: STATUS.critical, icon: "CircleX" };
  return { color: STATUS.warning, icon: "Clock" };
}

// --------------------------------------------------------------- sign-in

function SignIn({
  state,
  message,
  onDone,
}: {
  state: Dashboard["state"];
  message: string | null;
  onDone: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [pending, setPending] = useState(false);
  const [info, setInfo] = useState<{ message: string; url: string | null } | null>(null);
  const start = () => {
    setPending(true);
    rpc
      .call("login", null)
      .then(
        (result) => setInfo({ message: result.message, url: result.url }),
        (cause: unknown) =>
          setInfo({ message: cause instanceof Error ? cause.message : String(cause), url: null }),
      )
      .finally(() => setPending(false));
  };
  if (state === "missing-cli") {
    return (
      <Section title="Higgsfield CLI not found">
        <p className="text-sm text-muted-foreground">
          {message} The plugin uses the official CLI for sign-in and data. Install it, then
          reopen this page, or set the CLI path under Settings → Plugins → Higgsfield.
        </p>
      </Section>
    );
  }
  return (
    <Section title="Sign in to Higgsfield">
      <p className="text-sm text-muted-foreground">
        Sign-in runs through Higgsfield&apos;s own browser login (OAuth). Choose{" "}
        <strong className="text-foreground">Continue with Google</strong> there. The token stays
        with the Higgsfield CLI on this machine; the plugin never stores it.
      </p>
      <div className="mt-4 flex items-center gap-2">
        <Button onClick={start} disabled={pending}>
          <Icon name="LogIn" className="size-4" />
          {pending ? "Opening browser…" : "Sign in with browser"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          I&apos;ve signed in
        </Button>
      </div>
      {info === null ? null : (
        <p className="mt-3 text-sm">
          {info.message}{" "}
          {info.url === null ? null : (
            <UrlLink href={info.url} className="underline">
              Open the sign-in page
            </UrlLink>
          )}
        </p>
      )}
      {message === null ? null : (
        <p className="mt-3 text-xs text-muted-foreground">CLI said: {message}</p>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------- page

function ReadyDashboard({ data }: { data: Dashboard }) {
  const palette = usePalette();
  const [range, setRange] = useState<RangeKey>("cycle");
  const [colorBy, setColorBy] = useState<ColorBy>("model");
  const summary = useMemo(
    () => summarize(data.transactions, rangeStart(range, data.cycle)),
    [data, range],
  );
  const mediaOf = useMemo(() => {
    const map = new Map<string, Media | null>();
    for (const tx of data.transactions) if (!map.has(tx.label)) map.set(tx.label, tx.media);
    return map;
  }, [data.transactions]);
  const resolve = useCallback(
    (label: string) =>
      seriesOf({ label, media: mediaOf.get(label) ?? null }, colorBy, data.slots, palette),
    [mediaOf, colorBy, data.slots, palette],
  );
  const series = useMemo(
    () => seriesList(summary.models, colorBy, data.slots, palette),
    [summary.models, colorBy, data.slots, palette],
  );
  const c = data.cycle;
  const credits = data.account?.credits ?? null;
  const rangeLabel = RANGES.find((r) => r.key === range)?.label.toLowerCase() ?? "";
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          icon="Coins"
          label="Credits available"
          value={fmt(credits, 1)}
          sub={data.account?.plan === null ? undefined : `${data.account?.plan ?? ""} plan`}
        >
          {c === null || credits === null ? null : (
            <div className="mt-2 h-1.5 rounded-full bg-muted" title={`${fmt(credits)} of ${fmt(c.grantAmount)} monthly grant`}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, (credits / Math.max(1, c.grantAmount)) * 100)}%`,
                  backgroundColor: palette.slot(0),
                }}
              />
            </div>
          )}
        </Stat>
        <Stat
          icon="CalendarSync"
          label="Next reset"
          value={c === null ? "—" : `in ${plural(Math.ceil(c.daysToReset), "day")}`}
          sub={
            c === null ? (
              "No subscription grant found"
            ) : (
              <>
                {shortDate(c.nextResetAt)} ·{" "}
                <span style={{ color: palette.success }}>+{fmt(c.grantAmount)} credits</span>
              </>
            )
          }
        />
        <Stat
          icon="Flame"
          label="Burn rate"
          value={`${fmt(data.forecast.burnCycle, 1)}/day`}
          sub={`${fmt(data.forecast.burn7d, 1)}/day over the last 7 days`}
        />
        <Stat
          icon="Sparkles"
          label={`Spent · ${rangeLabel}`}
          value={fmt(summary.spent, 1)}
          sub={`${plural(summary.generations, "generation")} · ${fmt(summary.refunds)} refunded`}
        />
      </div>

      <ForecastCard data={data} />

      {data.warnings.map((warning) => (
        <p key={warning} className="text-xs text-muted-foreground">
          <Icon name="TriangleAlert" className="mr-1 inline size-3.5" />
          {warning}
        </p>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="Range" value={range} options={RANGES} onChange={setRange} />
        <Segmented
          label="Color by"
          value={colorBy}
          options={[
            { key: "model", label: "By model" },
            { key: "media", label: "By type" },
          ]}
          onChange={setColorBy}
        />
        <span className="text-xs text-muted-foreground">
          {shortDate(summary.from.toISOString())} – today
          {data.truncated ? " · older history truncated" : ""}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Section
          className="lg:col-span-3"
          title="Credits spent per day"
          aside={<Legend series={series} />}
        >
          <DailyBars summary={summary} series={series} resolve={resolve} />
        </Section>
        <Section
          className="lg:col-span-2"
          title="Where credits went"
          aside={`${fmt(summary.spent, 1)} credits`}
        >
          <Breakdown models={summary.models} series={series} resolve={resolve} />
        </Section>
      </div>

      <Section
        title="Generations by model"
        aside={`${plural(summary.models.length, "model")} · ${plural(summary.generations, "generation")}`}
      >
        <ModelTable summary={summary} resolve={resolve} />
      </Section>


      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Recent transactions">
          {data.transactions.length === 0 ? (
            <EmptyState>No transactions.</EmptyState>
          ) : (
            <Table
              head={["When", "What", "Credits"]}
              rows={data.transactions.slice(0, 15).map((tx, index) => {
                const cat = CATEGORY[tx.category];
                const isModel = tx.category === "spend" || tx.category === "refund";
                return {
                  key: `${tx.id}-${index}`,
                  cells: [
                    <span className="whitespace-nowrap text-muted-foreground">{dateTime(tx.at)}</span>,
                    <span className="flex min-w-0 items-center gap-2">
                      {isModel ? (
                        <Swatch color={resolve(tx.label).color} />
                      ) : (
                        <Icon name={cat.icon} className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">{tx.label}</span>
                      {tx.category === "spend" ? null : (
                        <span className="shrink-0 text-[11px] text-muted-foreground">{cat.label}</span>
                      )}
                    </span>,
                    <span
                      className={tx.amount > 0 ? "font-medium" : "text-muted-foreground"}
                      style={tx.amount > 0 ? { color: palette.success } : undefined}
                    >
                      {tx.amount > 0 ? "+" : ""}
                      {fmt(tx.amount, 2)}
                    </span>,
                  ],
                };
              })}
            />
          )}
        </Section>
        <Section
          title="Recent generations"
          aside={data.jobStatus
            .slice(0, 3)
            .map((entry) => `${entry.count} ${entry.status}`)
            .join(" · ")}
        >
          {data.jobs.length === 0 ? (
            <EmptyState>No recent generation jobs.</EmptyState>
          ) : (
            <Table
              head={["When", "Model", "Status"]}
              rows={data.jobs.slice(0, 15).map((job) => {
                const st = jobStatus(job.status);
                return {
                  key: job.id,
                  cells: [
                    <span className="whitespace-nowrap text-muted-foreground">{dateTime(job.at)}</span>,
                    <span className="flex min-w-0 items-center gap-2" title={job.prompt ?? undefined}>
                      <Swatch color={resolve(job.model).color} />
                      {job.resultUrl === null ? (
                        <span className="truncate">{job.model}</span>
                      ) : (
                        <UrlLink href={job.resultUrl} className="truncate hover:underline">
                          {job.model}
                        </UrlLink>
                      )}
                      <MediaTag media={job.media} />
                    </span>,
                    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs">
                      <Icon name={st.icon} className="size-3.5" style={{ color: st.color }} />
                      {job.status}
                    </span>,
                  ],
                };
              })}
            />
          )}
        </Section>
      </div>
    </div>
  );
}

function DashboardPage() {
  const { rpc, data, error, loading, load } = useDashboard();
  const signOut = () => {
    rpc.call("logout", null).then(() => load(true), () => load(true));
  };
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-6xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 text-sm text-muted-foreground">
            {data?.account === null || data?.account === undefined ? (
              "Higgsfield credits and consumption"
            ) : (
              <>
                <span className="text-foreground">{data.account.email ?? "Signed in"}</span>
                {data.account.plan === null ? null : (
                  <span className="ml-2 rounded border border-border px-1.5 py-px text-xs uppercase tracking-wide">
                    {data.account.plan}
                  </span>
                )}
                {data.workspace === null ? null : ` · workspace ${data.workspace}`}
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            {data === null ? null : (
              <span className="mr-2 text-xs text-muted-foreground">
                Updated {dateTime(data.fetchedAt)}
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={() => load(true)} disabled={loading}>
              <Icon name="RefreshCw" className={cn("size-4", loading && "animate-spin")} />
              Refresh
            </Button>
            {data?.state === "ready" ? (
              <Button variant="ghost" size="sm" onClick={signOut}>
                <Icon name="LogOut" className="size-4" />
                Sign out
              </Button>
            ) : null}
          </div>
        </header>

        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {data === null ? (
          <EmptyState>Loading Higgsfield account…</EmptyState>
        ) : data.state === "signed-out" || data.state === "missing-cli" ? (
          <SignIn state={data.state} message={data.message} onDone={() => load(true)} />
        ) : data.state === "error" ? (
          <Section title="Could not load Higgsfield data">
            <p className="text-sm text-muted-foreground">{data.message}</p>
          </Section>
        ) : (
          <ReadyDashboard data={data} />
        )}
      </div>
    </div>
  );
}

const Coins = LUCIDE.Coins;

export default definePluginApp((app) => {
  // Shared app icon for the sidebar entry (the host set has no "Coins").
  if (Coins !== undefined) {
    app.experimental_icons.register({
      name: "higgsfield-coins",
      component: ({ className }: { className?: string }) => <Coins className={className} />,
    });
  }
  app.slots.navPanel({
    id: "dashboard",
    title: "Higgsfield",
    icon: "higgsfield-coins",
    // Routed at /plugins/higgsfield/dashboard.
    path: "dashboard",
    component: DashboardPage,
  });
});
