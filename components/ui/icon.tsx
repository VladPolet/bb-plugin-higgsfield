// Plugin icons: lucide glyphs bundled with the plugin (the host's built-in
// icon set uses different names), falling back to the host icon registry
// for any name not listed here.
import type { ComponentType, CSSProperties, SVGProps } from "react";
import {
  experimental_Icon,
  type ExperimentalIconProps,
} from "@get-bb/plugin-sdk/app";
import {
  CalendarSync,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock,
  Coins,
  Flame,
  Hourglass,
  Image,
  LogIn,
  LogOut,
  Music,
  PackagePlus,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Type,
  Undo2,
  Video,
} from "lucide-react";

export const LUCIDE: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  CalendarSync,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock,
  Coins,
  Flame,
  Hourglass,
  Image,
  LogIn,
  LogOut,
  Music,
  PackagePlus,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Type,
  Undo2,
  Video,
};

const HostIcon = experimental_Icon;

export type IconName = string;
export type IconProps = ExperimentalIconProps;

export function Icon({ name, className, style, ...rest }: IconProps & { style?: CSSProperties }) {
  const Glyph = LUCIDE[name];
  if (Glyph === undefined) {
    return <HostIcon name={name} className={className} style={style} {...rest} />;
  }
  return <Glyph aria-hidden className={className} style={style} strokeWidth={2} />;
}
