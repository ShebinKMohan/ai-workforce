# Human portrait collection

Sixteen original fictional adult portraits, generated with the built-in imagegen tool for AI Workforce. The set includes eight masculine and eight feminine presentations, varied skin tones and ages, natural hairstyles, and professional clothing. No external identity, third-party artwork, stock-photo service, or account is used at render time.

Each WebP is one horizontal four-frame expression strip: neutral, eyes closed for a blink, slight right glance, and a small smile. Prompts requested polished semi-realistic 3D character rendering. These are pre-rendered CGI-style images, not live rigged 3D meshes. The complete assets remain local; the original generated PNGs are preserved at their source paths in `generation.json`. WebP encoding uses quality 90 and method 6 without changing dimensions or frame positions. The 16 production sprites total 7,906,944 bytes, 83% smaller than the original PNGs.

The avatar component crops frames in CSS without modifying the master art. Its controller changes actual face expressions; the entire image does not float, rotate, or pretend to perform work. Animation is decorative and independent of agent/task state. Offscreen portraits, hidden tabs, reduced motion, detached nodes, and disposed components schedule no expression timers. The first frame is the still fallback.

`generation.json` records prompts and source files. `assets.json` records dimensions and bytes. The stable `portrait-01` through `portrait-16` identifiers preserve saved selections. `preview.html` is an asset inspection sheet, separate from the application's task interface.
