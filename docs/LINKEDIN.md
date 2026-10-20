# LinkedIn post

Ready to copy and paste. Attach the image listed below (a real screenshot from the project). LinkedIn
tends to show posts with external links to fewer people, so a common approach is to put the links in
the first comment instead of the post. The post works either way.

**Image to attach:** `docs/images/report.png (or flamegraph.png)`

**First comment (optional):** Run it: npx github:feresbr1/perfproof run -- npm test · Code: https://github.com/feresbr1/perfproof

---

Find the slow line. Prove the fix.

I built perfproof, a CPU profiler and benchmark for Node.js, after noticing two problems.

1. Profiles are hard to act on. node --cpu-prof gives you a JSON call tree to explore by hand. perfproof reads it for you and ranks the lines that cost the most CPU, with the code around them and a hint for common slow patterns (linear scans in loops, regexes rebuilt per call, sync I/O…). It covers every Node.js process a command starts, so "perfproof run -- npm test" includes npm, the test runner and its workers.

2. "It feels faster" is not evidence. perfproof bench saves a baseline, re-runs after your change, and applies Welch's t-test. In the demo, two one-line fixes on the hottest lines gave: "FASTER: 2.88× faster than the baseline (-65.2% time, p < 0.0001)". Noise is reported as noise.

Something I didn't expect: a plain V8 profile can blame the wrong line. When a hot loop is optimised with on-stack replacement, its time lands on the line that called the function. perfproof turns that off while profiling.

The output is short and plain text, so AI coding agents can use it too, and there's an agent skill for that. One file, no dependencies, MIT. Node.js 22.15+.

💻 https://github.com/feresbr1/perfproof
🌐 https://feresbr1.github.io/perfproof/

#nodejs #performance #javascript #opensource #developertools
