type StatusBarProps = {
  ocrInstalled: boolean;
  version?: string;
};

// npm 全局安装命令与官方页面：未安装时引导用户安装 ocr CLI。
const INSTALL_CMD = "npm i -g @alibaba-group/open-code-review";
const INSTALL_URL = "https://www.npmjs.com/package/@alibaba-group/open-code-review";

// 纯展示组件：根据 ocr 是否安装显示状态徽标；未安装时提供一键复制安装命令 + 跳转安装页。
export default function StatusBar({ ocrInstalled, version }: StatusBarProps) {
  const handleInstall = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_CMD);
    } catch {
      // 剪贴板不可用时静默忽略，仍提供跳转链接。
    }
    window.open(INSTALL_URL, "_blank", "noreferrer");
  };

  return (
    <header className="status-bar">
      <span className="status-title">Open Code Review 配置器</span>
      <span className={"status-badge " + (ocrInstalled ? "ok" : "fail")}>
        {ocrInstalled ? (
          <>ocr ✓ {version ? `v${version}` : ""}</>
        ) : (
          <>
            ocr ✗ 未安装{" "}
            <button
              type="button"
              className="install-link"
              onClick={handleInstall}
              title={`点击复制并跳转安装：${INSTALL_CMD}`}
            >
              [安装引导]
            </button>
          </>
        )}
      </span>
    </header>
  );
}
