import { formatError } from "./ports";

type RestartAsAdmin = () => Promise<void>;

export type AdminRestartState = {
  restarting: boolean;
  notice: string;
  error: string;
};

export async function resolveAdminRestart(
  restartAsAdmin: RestartAsAdmin,
): Promise<AdminRestartState> {
  try {
    await restartAsAdmin();

    return {
      restarting: false,
      notice: "已请求管理员权限，请在弹出的窗口中确认。",
      error: "",
    };
  } catch (restartError) {
    return {
      restarting: false,
      notice: "",
      error: formatError(restartError),
    };
  }
}
