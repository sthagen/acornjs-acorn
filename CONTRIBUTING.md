# How to contribute

## Submitting bug reports

Report bugs on the [issue
tracker](https://github.com/acornjs/acorn/issues). Before be clear in
your description of the issue and, if at all practical, provide a
small script that demonstrates the problem.

## Contributing code

Code written by "AI" language models (either partially or fully) is
**not welcome**. You can use them for inspiration or as a discussion
partner if you must, but if you want us to review your code we
demand you make the effort to actually write it.

Follow the general code code style of the rest of the project and
make sure the linter (`npm run lint`) passes.

If you add code to parse a new construct to the main parser, make sure
the loose parser in `acorn-loose/` also supports the construct. If you
add new node types (which must be based on
[estree](https://github.com/estree/estree)), make sure you add support
for them to the AST walker in `acorn-walk/`.

Run the tests before submitting a pull request and consider adding
tests for any fix or new feature you add.

By contributing to Acorn you:

 - Agree to license the contributed code under the project's [MIT
   license](https://github.com/acornjs/acorn/blob/master/acorn/LICENSE).

 - Confirm that you have the right to contribute and license the code
   in question. (Either you hold all rights on the code, or the rights
   holder has explicitly granted the right to use it like this,
   through a compatible open source license or through a direct
   agreement with you.)
