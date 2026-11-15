# 液态玻璃材质 v2 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 SVG 位移折射、边缘光照与交互形变替换现有磨砂玻璃，实现接近液态玻璃的整体材质。

**Architecture:** 在应用外壳挂一份隐藏 SVG 滤镜定义；各玻璃表面内部绘制与页面共用的
环境色场与纹理，再通过普通 `filter` 引用位移滤镜。CSS 令牌区分厚玻璃/主面板/薄卡片三档，
指向指针的 CSS 变量驱动镜面高光。

**Tech Stack:** React 18、TypeScript、纯 CSS/SVG、Tauri 2 WebView2。

**Spec:** `docs/superpowers/specs/2026-11-15-liquid-glass-material-design.md`

**Related shell spec:** `docs/superpowers/specs/2026-11-15-cockpit-shell-redesign.md`

## Global Constraints

- 不新增运行时依赖。
- 所有可交互控件必须保留清晰的焦点态与键盘可达性。
- 动效时长：按压 90ms、状态 150ms、进场 220ms。
- 必须在 `prefers-reduced-motion`、`prefers-reduced-transparency`、
  `prefers-contrast: more`、`forced-colors: active` 下降级。
- 每个任务结束后运行 `pnpm typecheck`。

## Review Focus

- 密集文字背后的大面板：折射不得让正文发虚。
- 滚动长列表时：滤镜不得造成明显掉帧或闪烁。
- 深色自定义主题：白色边缘光不得过曝，暗边不得变成灰框。
- 触屏/无指针设备：不得残留上一次的镜面光斑。

---

### Task 1: 材质滤波器与指针光

**Files:**
- Create: `src/components/LiquidGlassFilters.tsx`
- Create: `src/hooks/useGlassPointer.ts`
- Modify: `src/App.tsx`

- [x] 建立 `#lg-lens` / `#lg-lens-soft` 位移滤镜，中心零位移、边缘渐进。
- [x] 在外壳上节流写入 `--lg-px` / `--lg-py`，减少动效或触屏时跳过。
- [x] 运行 `pnpm typecheck`。

### Task 2: 材质令牌与基础层级

**Files:**
- Modify: `src/lib/theme.ts`
- Modify: `src/styles/glass.css`
- Test: `src/lib/theme.test.ts`

- [x] 降低玻璃底色不透明度，新增折射、边缘光、镜面光令牌。
- [x] 重写外壳、侧栏、顶栏、导航选中项、搜索框的材质。
- [x] 增加单测断言玻璃令牌的透明度与折射范围。
- [x] 运行 `pnpm test src/lib/theme.test.ts` 与 `pnpm typecheck`。

### Task 3: 主面板与卡片层级

**Files:**
- Modify: `src/styles/glass.css`

- [x] 主面板使用薄玻璃 + 弱位移；看板列使用凹槽材质。
- [x] 任务卡片使用轻玻璃，悬停仅增强边缘光与阴影。
- [x] 浮层使用厚玻璃 + 强位移。
- [x] 运行 `pnpm typecheck`。

### Task 4: 交互形变与降级

**Files:**
- Modify: `src/styles/glass.css`

- [x] 导航、分段控制、按钮增加按压与回弹。
- [x] 减少动效/透明度/对比度/强制颜色四种媒体查询下退回实体表面。
- [x] 运行 `pnpm typecheck`。

### Task 5: 实机验收

- [x] 启动 `pnpm dev`，在驾驶舱、看板、时间线、洞察与船坞逐页截图检查。
- [x] 检查 390px 窄屏顶栏、侧栏与驾驶舱布局，无页面级横向溢出。
- [x] 运行 `pnpm test` 与 `pnpm build`。
- [x] 在 `docs/更新记录.md` 记录本次材质升级。
