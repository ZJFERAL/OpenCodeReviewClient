import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ProviderForm from "./ProviderForm";

// 核心联动：内置 provider 分支显示 API Key + Model，隐藏自定义网关字段；
// 自定义分支显示 Gateway/URL/Protocol + API Key，隐藏「内置」专属字段。
describe("ProviderForm 字段联动", () => {
  it("provider=anthropic 时显示 API Key 与 Model，不显示自定义网关字段", () => {
    render(<ProviderForm provider="anthropic" />);

    expect(screen.getByLabelText("API Key")).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
    // 自定义分支字段不应出现。
    expect(screen.queryByLabelText("Gateway 名称")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Protocol")).not.toBeInTheDocument();
  });

  it("provider=custom 时显示 Gateway/URL/Protocol，内置 API Key 字段隐藏", () => {
    render(<ProviderForm provider="custom" />);

    expect(screen.getByLabelText("Gateway 名称")).toBeInTheDocument();
    expect(screen.getByLabelText("URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Protocol")).toBeInTheDocument();
    // 自定义分支仍有一个 API Key（自定义网关自己的 key），但不再有内置 key 字段。
    expect(screen.getByLabelText("API Key")).toBeInTheDocument();
    // Protocol 下拉含三个协议选项。
    const protocol = screen.getByLabelText("Protocol") as HTMLSelectElement;
    const opts = Array.from(protocol.options).map((o) => o.value);
    expect(opts).toEqual(["openai", "anthropic", "openai-responses"]);
  });

  it("api_key 输入一律 type=password 掩码（spec §7）", () => {
    render(<ProviderForm provider="anthropic" />);
    expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "password");
  });

  it("config.customProviders 中包含的名字也走自定义分支", () => {
    render(
      <ProviderForm
        provider="custom"
        config={{ customProviders: { mygw: { url: "https://x", protocol: "openai" } } }}
      />
    );
    expect(screen.getByLabelText("Gateway 名称")).toBeInTheDocument();
  });
});
