import type { FileType } from "../types";

export function formatBytes(bytes: number | undefined, precision = 1): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  const digits = index === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : precision;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString.replace(" ", "T") + "+08:00");
  if (Number.isNaN(date.getTime())) return dateString;
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} 天前`;
  return date.toLocaleDateString("zh-CN");
}

export function formatClock(date = new Date()): string {
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function fileBaseName(filePath: string): string {
  return filePath.split("/").filter(Boolean).at(-1) ?? filePath;
}

export function parentPath(filePath: string): string {
  const segments = filePath.split("/").filter(Boolean);
  if (segments.length <= 1) return "";
  return segments.slice(0, -1).join("/");
}

export function typeLabel(type: FileType): string {
  return type === 1 ? "系统" : type === 2 ? "欧卡" : type === 3 ? "美卡" : "其他";
}
