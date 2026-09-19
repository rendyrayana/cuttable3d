# GitHub Setup Guide — Cuttable

Everything here is run by you in a terminal. Claude Code can write the project
files, but you own git init/commit/push so commits are clean and under your
name only.

## Proposed repo name
**`cuttable`**

Alternatives if taken/you want something else: `cuttable3d`, `cuttable-app`,
`cuttable-game`.

## 1. Create the repo on GitHub
Go to https://github.com/new
- Repository name: `cuttable`
- Visibility: your choice
- Do **not** auto-init with a README (you'll push one from local)

## 2. Initialize locally
From your project folder:
```bash
git init
git branch -M main
```

## 3. Add a `.gitignore`
```bash
cat > .gitignore << 'EOF'
node_modules/
dist/
.DS_Store
*.log
EOF
```

## 4. Stage and commit — with your name only
By default, if you ask Claude Code to run `git commit` for you, it will add
trailers like:
```
🤖 Generated with Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>
```
To avoid that, either:

**Option A (recommended): commit yourself, not via Claude Code**
```bash
git add .
git commit -m "Initial commit: Cuttable prototype scaffold"
```
This guarantees no trailer is added — you're the only author.

**Option B: if you do let Claude Code run the commit**
Tell it explicitly in your prompt, e.g.:
> "Commit with message '...' — do not add a Co-Authored-By or Generated with
> Claude Code trailer, plain commit only."
Check the result with `git log -1` before pushing, since this relies on the
instruction being followed correctly.

## 5. Set your commit identity (if not already set globally)
```bash
git config user.name "Your Name"
git config user.email "your@email.com"
```
(Omit `--global` above if you only want this for this repo.)

## 6. Connect the remote and push
```bash
git remote add origin https://github.com/<your-username>/cuttable.git
git push -u origin main
```

## 7. Optional but recommended repo settings
- Add a short README description + topics (`threejs`, `3d-printing`,
  `csg`, `game-prototype`) for discoverability
- Add a LICENSE (MIT is a common default for prototypes like this)
- Turn on GitHub Pages later if you want to host the playable build directly
  from `dist/`

## Ongoing workflow
For future commits, same rule: run `git commit` yourself in the terminal (or
explicitly instruct Claude Code to skip trailers) so every commit in the repo
history is authored cleanly by you.
