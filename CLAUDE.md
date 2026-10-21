# CLAUDE.md

See [AGENTS.md](AGENTS.md) for the repository layout, stack, and engineering rules.

## Rust Toolchain Policy

- The Rust toolchain is **pinned to `1.85.0`** across `contracts/` (`contracts/rust-toolchain.toml`), `indexer/` (`indexer/rust-toolchain.toml`), and GitHub Actions CI (`.github/workflows/ci.yml`).
- Do **not** assume rolling `stable` or run `rustup update stable` to bypass the pin; `rustup` automatically selects `1.85.0` from the `rust-toolchain.toml` files so local Clippy, rustfmt, and WASM builds match CI bit-for-bit.
