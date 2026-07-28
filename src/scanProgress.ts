export type ScanProgress = {
  label: string;
  value: number;
};

export const scanProgressSteps = {
  preparing: { label: "准备扫描界面", value: 12 },
  checkingRuntime: { label: "检测权限与运行环境", value: 28 },
  scanning: { label: "扫描 TCP / UDP 端口", value: 62 },
  rendering: { label: "整理进程与路径信息", value: 88 },
  complete: { label: "扫描完成", value: 100 },
} satisfies Record<string, ScanProgress>;

export function progressBarStyle(progress: ScanProgress) {
  const value = Math.min(100, Math.max(0, Math.round(progress.value)));
  return { width: `${value}%` };
}
