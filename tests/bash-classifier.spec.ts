import { describe, expect, test } from "vitest";
import { classifyBashCommand, tokenize } from "../src/policy/bash-classifier.js";

const ok  = (cmd: string) => expect(classifyBashCommand(cmd).cacheable).toBe(true);
const nope = (cmd: string) => expect(classifyBashCommand(cmd).cacheable).toBe(false);

describe("tokenize", () => {
  test("plain words", () => {
    expect(tokenize("ls -la /tmp")).toEqual(["ls", "-la", "/tmp"]);
  });
  test("single-quoted preserves spaces", () => {
    expect(tokenize("grep 'hello world' file")).toEqual(["grep", "hello world", "file"]);
  });
  test("double-quoted with escapes", () => {
    expect(tokenize('echo "a\\"b"')).toEqual(["echo", 'a"b']);
  });
});

describe("classifyBashCommand — read-only", () => {
  test.each([
    "ls",
    "ls -la /tmp",
    "cat README.md",
    "head -n 20 file.txt",
    "tail -n 5 some.log",
    "wc -l package.json",
    "find . -name '*.ts'",
    "grep -r 'TODO' src",
    "git log --oneline -10",
    "git status",
    "git diff HEAD~1",
    "git branch",
    "node --version",
    "npm ls",
    "mvn -version",
    "uname -a",
    "pwd",
    "which node",
    "echo hello",
    "date",
    "git log --oneline | head -20",       // safe pipe
    "ls -la | wc -l",                      // safe pipe
    "cat foo.txt | grep bar | wc -l",      // 3-segment safe pipe
  ])("ok: %s", (cmd) => ok(cmd));
});

describe("classifyBashCommand — must reject", () => {
  test.each([
    "rm -rf /tmp/x",
    "mv a b",
    "cp a b",
    "npm install",
    "npm run build",
    "mvn clean install",
    "docker run alpine",
    "kubectl apply -f x.yml",
    "git push",
    "git commit -m 'x'",
    "git pull",
    "curl https://example.com",
    "wget https://example.com",
    "echo x > out.txt",                    // redirect
    "echo x >> out.txt",                   // append
    "ls; rm -rf /",                        // command separator
    "ls && rm -rf /",                      // logical and
    "ls || true",                          // logical or
    "ls $(rm -rf /)",                      // command sub
    "ls `rm -rf /`",                       // backticks
    "sudo ls",                             // privilege
    "sed -i s/x/y/ file",                  // mutating sed
    "find . -delete",                      // mutating find
    "cat foo > bar",                       // redirect with cat
    "ls | npm install",                    // pipe ending in mutator
    "",                                    // empty
    "   ",                                 // whitespace only
  ])("reject: %s", (cmd) => nope(cmd));
});

describe("classifyBashCommand — overrides", () => {
  test("allow extends the whitelist", () => {
    expect(classifyBashCommand("custom-tool --help").cacheable).toBe(false);
    expect(
      classifyBashCommand("custom-tool --help", { allow: ["custom-tool"] }).cacheable,
    ).toBe(true);
  });
  test("deny overrides the whitelist", () => {
    expect(classifyBashCommand("ls -la").cacheable).toBe(true);
    expect(classifyBashCommand("ls -la", { deny: ["ls"] }).cacheable).toBe(false);
  });
});
