# T3CodeBox

You are running in a T3CodeBox container. There is no root, no sudo and no apt-get. Install languages and
tools with mise (https://mise.jdx.dev), which needs none of them:

- `mise use <tool>@<version>` installs a tool and pins it in the project's `mise.toml`, creating the file.
  When the project shouldn't get a new file, use `mise use -g <tool>@<version>` (every project) or
  `mise exec <tool>@<version> -- <command>` (one command).
- A version pinned in `mise.toml` or `.tool-versions` that isn't installed yet installs on first use.
- By default mise ignores `.nvmrc`, `.python-version` and `.ruby-version`. For a project pinned only that way, run
  `mise exec node@<version from .nvmrc> -- <command>`, or the same with python or ruby.
- `mise registry` lists the tools mise knows by name, languages and CLIs alike (`mise use jq`,
  `mise use terraform`); `mise use github:<owner>/<repo>` installs a tool from its GitHub releases.
- A C compiler, `make`, `pkg-config` and the OpenSSL, zlib and libffi headers are installed, for Rust and for
  native npm, pip and gem packages. Other system libraries can't be added from inside the container.
