const { relative } = require("node:path");

function emit(kind, test, status) {
  process.stdout.write(`ABBY_BROWSER_EVENT ${JSON.stringify({ kind,
    file: relative(process.cwd(), test.location.file), line: test.location.line,
    title: test.title, ...(status === undefined ? {} : { status }) })}\n`);
}

module.exports = class BrowserOrderReporter {
  onTestBegin(test) { emit("prepared", test); }
  onStdOut(chunk) { process.stdout.write(chunk); }
  onTestEnd(test, result) {
    emit("finished", test, result.status);
    if (result.error) process.stderr.write(`${result.error.message ?? "browser test failed"}\n`);
  }
  onError(error) { process.stderr.write(`${error.message ?? "browser runner failed"}\n`); }
};
