# 此刻主题离线字体

这些字体由 Google Fonts 的 fonts.gstatic.com 发行文件本地托管，许可证随文件保留（SIL OFL 1.1）。无运行时下载或构建依赖。

- `cike-0/1/2.ttf`：Figtree 400 / 500 / 600。
- `cike-3/4.ttf`：Geist Mono 400 / 500。
- `cike-5/6.ttf`：Instrument Serif italic / regular 400。
- `noto-sc-0/1.woff2`：Noto Serif SC 400 / 500，使用 fontTools 将完整 TTF 无损压缩为 WOFF2，未删减汉字。

`cike-fonts.css` 和 `noto-sc.css` 只引用同源文件。旧主题的原有字体链接保留，但此刻主题的四套字体不依赖这些外部请求。

# 夜场主题离线字体

来自 Google Fonts 官方仓库 github.com/google/fonts 的可变字体原件（SIL OFL 1.1），由
`scripts/build-nocturne-fonts.py` 取固定字重并裁成子集，原件不入库。许可证随文件保留。

- `nocturne-serif-900.woff2` / `nocturne-serif-300.woff2`：思源宋体（Noto Serif SC）900 / 300，界面文案 + GB2312 一级常用字。
- 宋体 400 / 500 复用上面的 `noto-sc-0/1.woff2`（完整字符集）；500–800 的加粗落到 500，不跳到 900。
- `nocturne-sans-400.woff2`：思源黑体（Noto Sans SC）400，只含界面文案用字（`LICENSE-notosanssc.txt`）。
- `nocturne-latin-{300,400,500,800}.woff2`：Newsreader 300 / 400 / 500 / 800，只含拉丁字符（`LICENSE-newsreader.txt`）。
  宋体自带的拉丁字形在英文歌词和英文歌名上发楔、字距紧，所以夜场新增 `'Lunara Latin'` 族并排到
  `--font-display` / `--font-reading` 最前面：浏览器逐字回退，英文走 Newsreader、中文走标宋。
  opsz 轴保持可变，大标题拿标题字形、小字歌词拿正文字形。Newsreader 最高 800，700–900 档统一用 800 的实例。
- `nocturne-number.woff2`：Bodoni Moda 500，光学尺寸固定 11，只含拉丁、数字与常用标点（`LICENSE-bodonimoda.txt`）。

`nocturne-fonts.css` 用独立族名 'Lunara Serif' / 'Lunara Latin' / 'Lunara Sans' / 'Lunara Number'，只被夜场 tokens 引用。
