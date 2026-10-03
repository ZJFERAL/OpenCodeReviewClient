type StatusBarProps = {
  ocrInstalled: boolean;
  version?: string;
};

// 纯展示组件：根据 ocr 是否安装显示状态徽标。
export default function StatusBar({ ocrInstalled, version }: StatusBarProps) {
  return (
    <header className="status-bar">
      <span className="status-title">Open Code Review 配置器</span>
      <span className={"status-badge " + (ocrInstalled ? "ok" : "fail")}>
        {ocrInstalled ? (
          <>ocr ✓ {version ? `v${version}` : ""}</>
        ) : (
          <>
            ocr ✗ 未安装{" "}
            <a
              className="install-link"
              href="https://github.com/alibaba/open-code-review"
              target="_blank"
              rel="noreferrer"
            >
              [去安装]
            </a>
          </>
        )}
      </span>
    </header>
  );
}
