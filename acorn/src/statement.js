import {types as tt} from "./tokentype.js"
import {Parser} from "./state.js"
import {lineBreak, skipWhiteSpace} from "./whitespace.js"
import {isIdentifierStart, isIdentifierChar, keywordRelationalOperator} from "./identifier.js"
import {hasOwn, loneSurrogate} from "./util.js"
import {DestructuringErrors} from "./parseutil.js"
import {functionFlags, SCOPE_SIMPLE_CATCH, BIND_SIMPLE_CATCH, BIND_LEXICAL, BIND_VAR, BIND_FUNCTION, SCOPE_CLASS_STATIC_BLOCK, SCOPE_SUPER, SCOPE_CLASS_FIELD_INIT, SCOPE_SWITCH} from "./scopeflags.js"

const pp = Parser.prototype

// ### Statement parsing

// Parse a program. Initializes the parser, reads any number of
// statements, and wraps them in a Program node.  Optionally takes a
// `program` argument.  If present, the statements will be appended
// to its body instead of creating a new node.

pp.parseTopLevel = function(node) {
  let exports = Object.create(null)
  if (!node.body) node.body = []
  while (this.type !== tt.eof) {
    let stmt = this.parseStatement(null, true, exports)
    node.body.push(stmt)
  }
  if (this.inModule)
    for (let name of Object.keys(this.undefinedExports))
      this.raiseRecoverable(this.undefinedExports[name].start, `Export '${name}' is not defined`)
  this.adaptDirectivePrologue(node.body)
  this.next()
  node.sourceType = this.options.sourceType === "commonjs" ? "script" : this.options.sourceType
  return this.finishNode(node, "Program")
}

const loopLabel = {kind: "loop"}, switchLabel = {kind: "switch"}

pp.isLet = function(context) {
  if (this.options.ecmaVersion < 6 || !this.isContextual("let")) return false
  skipWhiteSpace.lastIndex = this.pos
  let skip = skipWhiteSpace.exec(this.input)
  let next = this.pos + skip[0].length, nextCh = this.fullCharCodeAt(next)
  // For ambiguous cases, determine if a LexicalDeclaration (or only a
  // Statement) is allowed here. If context is not empty then only a Statement
  // is allowed. However, `let [` is an explicit negative lookahead for
  // ExpressionStatement, so special-case it first.
  if (nextCh === 91 || nextCh === 92) return true // '[', '\'
  if (context) return false

  if (nextCh === 123) return true // '{'
  if (isIdentifierStart(nextCh)) {
    let start = next
    do { next += nextCh <= 0xffff ? 1 : 2 }
    while (isIdentifierChar(nextCh = this.fullCharCodeAt(next)))
    if (nextCh === 92) return true
    let ident = this.input.slice(start, next)
    if (!keywordRelationalOperator.test(ident)) return true
  }
  return false
}

// check 'async [no LineTerminator here] function'
// - 'async /*foo*/ function' is OK.
// - 'async /*\n*/ function' is invalid.
pp.isAsyncFunction = function() {
  if (this.options.ecmaVersion < 8 || !this.isContextual("async"))
    return false

  skipWhiteSpace.lastIndex = this.pos
  let skip = skipWhiteSpace.exec(this.input)
  let next = this.pos + skip[0].length, after
  return !lineBreak.test(this.input.slice(this.pos, next)) &&
    this.input.slice(next, next + 8) === "function" &&
    (next + 8 === this.input.length ||
     !(isIdentifierChar(after = this.fullCharCodeAt(next + 8)) || after === 92 /* '\' */))
}

pp.isUsingKeyword = function(isAwaitUsing, isFor) {
  if (this.options.ecmaVersion < 17 || !this.isContextual(isAwaitUsing ? "await" : "using"))
    return false

  skipWhiteSpace.lastIndex = this.pos
  let skip = skipWhiteSpace.exec(this.input)
  let next = this.pos + skip[0].length

  if (lineBreak.test(this.input.slice(this.pos, next))) return false

  if (isAwaitUsing) {
    let usingEndPos = next + 5 /* using */, after
    if (this.input.slice(next, usingEndPos) !== "using" ||
      usingEndPos === this.input.length ||
      isIdentifierChar(after = this.fullCharCodeAt(usingEndPos)) ||
      after === 92 /* '\' */
    ) return false

    skipWhiteSpace.lastIndex = usingEndPos
    let skipAfterUsing = skipWhiteSpace.exec(this.input)
    next = usingEndPos + skipAfterUsing[0].length
    if (skipAfterUsing && lineBreak.test(this.input.slice(usingEndPos, next))) return false
  }

  let ch = this.fullCharCodeAt(next)
  if (!isIdentifierStart(ch) && ch !== 92 /* '\' */) return false
  let idStart = next
  do { next += ch <= 0xffff ? 1 : 2 }
  while (isIdentifierChar(ch = this.fullCharCodeAt(next)))
  if (ch === 92) return true
  let id = this.input.slice(idStart, next)
  if (keywordRelationalOperator.test(id) || isFor && id === "of") return false
  return true
}

pp.isAwaitUsing = function(isFor) {
  return this.isUsingKeyword(true, isFor)
}

pp.isUsing = function(isFor) {
  return this.isUsingKeyword(false, isFor)
}

// Parse a single statement.
//
// If expecting a statement and finding a slash operator, parse a
// regular expression literal. This is to handle cases like
// `if (foo) /blah/.exec(foo)`, where looking at the previous token
// does not help.

pp.parseStatement = function(context, topLevel, exports) {
  let starttype = this.type, node = this.startNode(), kind

  if (this.isLet(context)) {
    starttype = tt._var
    kind = "let"
  }

  // Most types of statements are recognized by the keyword they
  // start with. Many are trivial to parse, some require a bit of
  // complexity.

  switch (starttype) {
  case tt._break: case tt._continue: return this.parseBreakContinueStatement(node, starttype.keyword)
  case tt._debugger: return this.parseDebuggerStatement(node)
  case tt._do: return this.parseDoStatement(node)
  case tt._for: return this.parseForStatement(node)
  case tt._function:
    // Function as sole body of either an if statement or a labeled statement
    // works, but not when it is part of a labeled statement that is the sole
    // body of an if statement.
    if ((context && (this.strict || context !== "if" && context !== "label")) && this.options.ecmaVersion >= 6) this.unexpected()
    return this.parseFunctionStatement(node, false, !context)
  case tt._class:
    if (context) this.unexpected()
    return this.parseClass(node, true)
  case tt._if: return this.parseIfStatement(node)
  case tt._return: return this.parseReturnStatement(node)
  case tt._switch: return this.parseSwitchStatement(node)
  case tt._throw: return this.parseThrowStatement(node)
  case tt._try: return this.parseTryStatement(node)
  case tt._const: case tt._var:
    kind = kind || this.value
    if (context && kind !== "var") this.unexpected()
    return this.parseVarStatement(node, kind)
  case tt._while: return this.parseWhileStatement(node)
  case tt._with: return this.parseWithStatement(node)
  case tt.braceL: return this.parseBlock(true, node)
  case tt.semi: return this.parseEmptyStatement(node)
  case tt._export:
  case tt._import:
    if (this.options.ecmaVersion > 10 && starttype === tt._import) {
      skipWhiteSpace.lastIndex = this.pos
      let skip = skipWhiteSpace.exec(this.input)
      let next = this.pos + skip[0].length, nextCh = this.input.charCodeAt(next)
      if (nextCh === 40 || nextCh === 46) // '(' or '.'
        return this.parseExpressionStatement(node, this.parseExpression())
    }

    if (!this.options.allowImportExportEverywhere) {
      if (!topLevel)
        this.raise(this.start, "'import' and 'export' may only appear at the top level")
      if (!this.inModule)
        this.raise(this.start, "'import' and 'export' may appear only with 'sourceType: module'")
    }
    return starttype === tt._import ? this.parseImport(node) : this.parseExport(node, exports)

    // If the statement does not start with a statement keyword or a
    // brace, it's an ExpressionStatement or LabeledStatement. We
    // simply start parsing an expression, and afterwards, if the
    // next token is a colon and the expression was a simple
    // Identifier node, we switch to interpreting it as a label.
  default:
    if (this.isAsyncFunction()) {
      if (context) this.unexpected()
      this.next()
      return this.parseFunctionStatement(node, true, !context)
    }

    let usingKind = this.isAwaitUsing(false) ? "await using" : this.isUsing(false) ? "using" : null
    if (usingKind) {
      if (!this.allowUsing) {
        this.raise(this.start, "Using declaration cannot appear in the top level when source type is `script` or in the bare case statement")
      }
      if (usingKind === "await using") {
        if (!this.canAwait) {
          this.raise(this.start, "Await using cannot appear outside of async function")
        }
        this.next()
      }
      this.next()
      this.parseVar(node, false, usingKind)
      this.semicolon()
      return this.finishNode(node, "VariableDeclaration")
    }

    let maybeName = this.value, expr = this.parseExpression()
    if (starttype === tt.name && expr.type === "Identifier" && this.eat(tt.colon))
      return this.parseLabeledStatement(node, maybeName, expr, context)
    else return this.parseExpressionStatement(node, expr)
  }
}

pp.parseBreakContinueStatement = function(node, keyword) {
  let isBreak = keyword === "break"
  this.next()
  if (this.eat(tt.semi) || this.insertSemicolon()) node.label = null
  else if (this.type !== tt.name) this.unexpected()
  else {
    node.label = this.parseIdent()
    this.semicolon()
  }

  // Verify that there is an actual destination to break or
  // continue to.
  let i = 0
  for (; i < this.labels.length; ++i) {
    let lab = this.labels[i]
    if (node.label == null || lab.name === node.label.name) {
      if (lab.kind != null && (isBreak || lab.kind === "loop")) break
      if (node.label && isBreak) break
    }
  }
  if (i === this.labels.length) this.raise(node.start, "Unsyntactic " + keyword)
  return this.finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement")
}

pp.parseDebuggerStatement = function(node) {
  this.next()
  this.semicolon()
  return this.finishNode(node, "DebuggerStatement")
}

pp.parseDoStatement = function(node) {
  this.next()
  this.labels.push(loopLabel)
  node.body = this.parseStatement("do")
  this.labels.pop()
  this.expect(tt._while)
  node.test = this.parseParenExpression()
  if (this.options.ecmaVersion >= 6)
    this.eat(tt.semi)
  else
    this.semicolon()
  return this.finishNode(node, "DoWhileStatement")
}

// Disambiguating between a `for` and a `for`/`in` or `for`/`of`
// loop is non-trivial. Basically, we have to parse the init `var`
// statement or expression, disallowing the `in` operator (see
// the second parameter to `parseExpression`), and then check
// whether the next token is `in` or `of`. When there is no init
// part (semicolon immediately after the opening parenthesis), it
// is a regular `for` loop.

pp.parseForStatement = function(node) {
  this.next()
  let awaitAt = (this.options.ecmaVersion >= 9 && this.canAwait && this.eatContextual("await")) ? this.lastTokStart : -1
  this.labels.push(loopLabel)
  this.enterScope(0)
  this.expect(tt.parenL)
  if (this.type === tt.semi) {
    if (awaitAt > -1) this.unexpected(awaitAt)
    return this.parseFor(node, null)
  }
  let isLet = this.isLet()
  if (this.type === tt._var || this.type === tt._const || isLet) {
    let init = this.startNode(), kind = isLet ? "let" : this.value
    this.next()
    this.parseVar(init, true, kind)
    this.finishNode(init, "VariableDeclaration")
    return this.parseForAfterInit(node, init, awaitAt)
  }
  let startsWithLet = this.isContextual("let"), isForOf = false

  let usingKind = this.isUsing(true) ? "using" : this.isAwaitUsing(true) ? "await using" : null
  if (usingKind) {
    let init = this.startNode()
    this.next()
    if (usingKind === "await using") {
      if (!this.canAwait) {
        this.raise(this.start, "Await using cannot appear outside of async function")
      }
      this.next()
    }
    this.parseVar(init, true, usingKind)
    this.finishNode(init, "VariableDeclaration")
    return this.parseForAfterInit(node, init, awaitAt)
  }
  let containsEsc = this.containsEsc
  let refDestructuringErrors = new DestructuringErrors
  let initPos = this.start
  let init = awaitAt > -1
    ? this.parseExprSubscripts(refDestructuringErrors, "await")
    : this.parseExpression(true, refDestructuringErrors)
  if (this.type === tt._in || (isForOf = this.options.ecmaVersion >= 6 && this.isContextual("of"))) {
    if (awaitAt > -1) { // implies `ecmaVersion >= 9` (see declaration of awaitAt)
      if (this.type === tt._in) this.unexpected(awaitAt)
      node.await = true
    } else if (isForOf && this.options.ecmaVersion >= 8) {
      if (init.start === initPos && !containsEsc && init.type === "Identifier" && init.name === "async") this.unexpected()
      else if (this.options.ecmaVersion >= 9) node.await = false
    }
    if (startsWithLet && isForOf) this.raise(init.start, "The left-hand side of a for-of loop may not start with 'let'.")
    this.toAssignable(init, false, refDestructuringErrors)
    this.checkLValPattern(init)
    return this.parseForIn(node, init)
  } else {
    this.checkExpressionErrors(refDestructuringErrors, true)
  }
  if (awaitAt > -1) this.unexpected(awaitAt)
  return this.parseFor(node, init)
}

// Helper method to parse for loop after variable initialization
pp.parseForAfterInit = function(node, init, awaitAt) {
  if ((this.type === tt._in || (this.options.ecmaVersion >= 6 && this.isContextual("of"))) && init.declarations.length === 1) {
    if (this.options.ecmaVersion >= 9) {
      if (this.type === tt._in) {
        if (awaitAt > -1) this.unexpected(awaitAt)
      } else node.await = awaitAt > -1
    }
    return this.parseForIn(node, init)
  }
  if (awaitAt > -1) this.unexpected(awaitAt)
  return this.parseFor(node, init)
}

pp.parseFunctionStatement = function(node, isAsync, declarationPosition) {
  this.next()
  return this.parseFunction(node, FUNC_STATEMENT | (declarationPosition ? 0 : FUNC_HANGING_STATEMENT), false, isAsync)
}

pp.parseIfStatement = function(node) {
  this.next()
  node.test = this.parseParenExpression()
  // allow function declarations in branches, but only in non-strict mode
  node.consequent = this.parseStatement("if")
  node.alternate = this.eat(tt._else) ? this.parseStatement("if") : null
  return this.finishNode(node, "IfStatement")
}

pp.parseReturnStatement = function(node) {
  if (!this.allowReturn)
    this.raise(this.start, "'return' outside of function")
  this.next()

  // In `return` (and `break`/`continue`), the keywords with
  // optional arguments, we eagerly look for a semicolon or the
  // possibility to insert one.

  if (this.eat(tt.semi) || this.insertSemicolon()) node.argument = null
  else { node.argument = this.parseExpression(); this.semicolon() }
  return this.finishNode(node, "ReturnStatement")
}

pp.parseSwitchStatement = function(node) {
  this.next()
  node.discriminant = this.parseParenExpression()
  node.cases = []
  this.expect(tt.braceL)
  this.labels.push(switchLabel)
  this.enterScope(SCOPE_SWITCH)

  // Statements under must be grouped (by label) in SwitchCase
  // nodes. `cur` is used to keep the node that we are currently
  // adding statements to.

  let cur
  for (let sawDefault = false; this.type !== tt.braceR;) {
    if (this.type === tt._case || this.type === tt._default) {
      let isCase = this.type === tt._case
      if (cur) this.finishNode(cur, "SwitchCase")
      node.cases.push(cur = this.startNode())
      cur.consequent = []
      this.next()
      if (isCase) {
        cur.test = this.parseExpression()
      } else {
        if (sawDefault) this.raiseRecoverable(this.lastTokStart, "Multiple default clauses")
        sawDefault = true
        cur.test = null
      }
      this.expect(tt.colon)
    } else {
      if (!cur) this.unexpected()
      cur.consequent.push(this.parseStatement(null))
    }
  }
  this.exitScope()
  if (cur) this.finishNode(cur, "SwitchCase")
  this.next() // Closing brace
  this.labels.pop()
  return this.finishNode(node, "SwitchStatement")
}

pp.parseThrowStatement = function(node) {
  this.next()
  if (lineBreak.test(this.input.slice(this.lastTokEnd, this.start)))
    this.raise(this.lastTokEnd, "Illegal newline after throw")
  node.argument = this.parseExpression()
  this.semicolon()
  return this.finishNode(node, "ThrowStatement")
}

// Reused empty array added for node fields that are always empty.

const empty = []

pp.parseCatchClauseParam = function() {
  const param = this.parseBindingAtom()
  let simple = param.type === "Identifier"
  this.enterScope(simple ? SCOPE_SIMPLE_CATCH : 0)
  this.checkLValPattern(param, simple ? BIND_SIMPLE_CATCH : BIND_LEXICAL)
  this.expect(tt.parenR)

  return param
}

pp.parseTryStatement = function(node) {
  this.next()
  node.block = this.parseBlock()
  node.handler = null
  if (this.type === tt._catch) {
    let clause = this.startNode()
    this.next()
    if (this.eat(tt.parenL)) {
      clause.param = this.parseCatchClauseParam()
    } else {
      if (this.options.ecmaVersion < 10) this.unexpected()
      clause.param = null
      this.enterScope(0)
    }
    clause.body = this.parseBlock(false)
    this.exitScope()
    node.handler = this.finishNode(clause, "CatchClause")
  }
  node.finalizer = this.eat(tt._finally) ? this.parseBlock() : null
  if (!node.handler && !node.finalizer)
    this.raise(node.start, "Missing catch or finally clause")
  return this.finishNode(node, "TryStatement")
}

pp.parseVarStatement = function(node, kind, allowMissingInitializer) {
  this.next()
  this.parseVar(node, false, kind, allowMissingInitializer)
  this.semicolon()
  return this.finishNode(node, "VariableDeclaration")
}

pp.parseWhileStatement = function(node) {
  this.next()
  node.test = this.parseParenExpression()
  this.labels.push(loopLabel)
  node.body = this.parseStatement("while")
  this.labels.pop()
  return this.finishNode(node, "WhileStatement")
}

pp.parseWithStatement = function(node) {
  if (this.strict) this.raise(this.start, "'with' in strict mode")
  this.next()
  node.object = this.parseParenExpression()
  node.body = this.parseStatement("with")
  return this.finishNode(node, "WithStatement")
}

pp.parseEmptyStatement = function(node) {
  this.next()
  return this.finishNode(node, "EmptyStatement")
}

pp.parseLabeledStatement = function(node, maybeName, expr, context) {
  for (let label of this.labels)
    if (label.name === maybeName)
      this.raise(expr.start, "Label '" + maybeName + "' is already declared")
  let kind = this.type.isLoop ? "loop" : this.type === tt._switch ? "switch" : null
  for (let i = this.labels.length - 1; i >= 0; i--) {
    let label = this.labels[i]
    if (label.statementStart === node.start) {
      // Update information about previous labels on this node
      label.statementStart = this.start
      label.kind = kind
    } else break
  }
  this.labels.push({name: maybeName, kind, statementStart: this.start})
  node.body = this.parseStatement(context ? context.indexOf("label") === -1 ? context + "label" : context : "label")
  this.labels.pop()
  node.label = expr
  return this.finishNode(node, "LabeledStatement")
}

pp.parseExpressionStatement = function(node, expr) {
  node.expression = expr
  this.semicolon()
  return this.finishNode(node, "ExpressionStatement")
}

// Parse a semicolon-enclosed block of statements, handling `"use
// strict"` declarations when `allowStrict` is true (used for
// function bodies).

pp.parseBlock = function(createNewLexicalScope = true, node = this.startNode(), exitStrict) {
  node.body = []
  this.expect(tt.braceL)
  if (createNewLexicalScope) this.enterScope(0)
  while (this.type !== tt.braceR) {
    let stmt = this.parseStatement(null)
    node.body.push(stmt)
  }
  if (exitStrict) this.strict = false
  this.next()
  if (createNewLexicalScope) this.exitScope()
  return this.finishNode(node, "BlockStatement")
}

// Parse a regular `for` loop. The disambiguation code in
// `parseStatement` will already have parsed the init statement or
// expression.

pp.parseFor = function(node, init) {
  node.init = init
  this.expect(tt.semi)
  node.test = this.type === tt.semi ? null : this.parseExpression()
  this.expect(tt.semi)
  node.update = this.type === tt.parenR ? null : this.parseExpression()
  this.expect(tt.parenR)
  node.body = this.parseStatement("for")
  this.exitScope()
  this.labels.pop()
  return this.finishNode(node, "ForStatement")
}

// Parse a `for`/`in` and `for`/`of` loop, which are almost
// same from parser's perspective.

pp.parseForIn = function(node, init) {
  const isForIn = this.type === tt._in
  this.next()

  if (
    init.type === "VariableDeclaration" &&
    init.declarations[0].init != null &&
    (
      !isForIn ||
      this.options.ecmaVersion < 8 ||
      this.strict ||
      init.kind !== "var" ||
      init.declarations[0].id.type !== "Identifier"
    )
  ) {
    this.raise(
      init.start,
      `${
        isForIn ? "for-in" : "for-of"
      } loop variable declaration may not have an initializer`
    )
  }
  node.left = init
  node.right = isForIn ? this.parseExpression() : this.parseMaybeAssign()
  this.expect(tt.parenR)
  node.body = this.parseStatement("for")
  this.exitScope()
  this.labels.pop()
  return this.finishNode(node, isForIn ? "ForInStatement" : "ForOfStatement")
}

// Parse a list of variable declarations.

pp.parseVar = function(node, isFor, kind, allowMissingInitializer) {
  node.declarations = []
  node.kind = kind
  for (;;) {
    let decl = this.startNode()
    this.parseVarId(decl, kind)
    if (this.eat(tt.eq)) {
      decl.init = this.parseMaybeAssign(isFor)
    } else if (!allowMissingInitializer && kind === "const" && !(this.type === tt._in || (this.options.ecmaVersion >= 6 && this.isContextual("of")))) {
      this.unexpected()
    } else if (!allowMissingInitializer && (kind === "using" || kind === "await using") && this.options.ecmaVersion >= 17 && this.type !== tt._in && !this.isContextual("of")) {
      this.raise(this.lastTokEnd, `Missing initializer in ${kind} declaration`)
    } else if (!allowMissingInitializer && decl.id.type !== "Identifier" && !(isFor && (this.type === tt._in || this.isContextual("of")))) {
      this.raise(this.lastTokEnd, "Complex binding patterns require an initialization value")
    } else {
      decl.init = null
    }
    node.declarations.push(this.finishNode(decl, "VariableDeclarator"))
    if (!this.eat(tt.comma)) break
  }
  return node
}

pp.parseVarId = function(decl, kind) {
  decl.id = kind === "using" || kind === "await using"
    ? this.parseIdent()
    : this.parseBindingAtom()

  this.checkLValPattern(decl.id, kind === "var" ? BIND_VAR : BIND_LEXICAL, false)
}

const FUNC_STATEMENT = 1, FUNC_HANGING_STATEMENT = 2, FUNC_NULLABLE_ID = 4

// Parse a function declaration or literal (depending on the
// `statement & FUNC_STATEMENT`).

// Remove `allowExpressionBody` for 7.0.0, as it is only called with false
pp.parseFunction = function(node, statement, allowExpressionBody, isAsync, forInit) {
  this.initFunction(node)
  if (this.options.ecmaVersion >= 9 || this.options.ecmaVersion >= 6 && !isAsync) {
    if (this.type === tt.star && (statement & FUNC_HANGING_STATEMENT))
      this.unexpected()
    node.generator = this.eat(tt.star)
  }
  if (this.options.ecmaVersion >= 8)
    node.async = !!isAsync

  if (statement & FUNC_STATEMENT) {
    node.id = (statement & FUNC_NULLABLE_ID) && this.type !== tt.name ? null : this.parseIdent()
    if (node.id && !(statement & FUNC_HANGING_STATEMENT))
      // If it is a regular function declaration in sloppy mode, then it is
      // subject to Annex B semantics (BIND_FUNCTION). Otherwise, the binding
      // mode depends on properties of the current scope (see
      // treatFunctionsAsVar).
      this.checkLValSimple(node.id, (this.strict || node.generator || node.async) ? this.treatFunctionsAsVar ? BIND_VAR : BIND_LEXICAL : BIND_FUNCTION)
  }

  let oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos
  this.yieldPos = 0
  this.awaitPos = 0
  this.awaitIdentPos = 0
  this.enterScope(functionFlags(node.async, node.generator))

  if (!(statement & FUNC_STATEMENT))
    node.id = this.type === tt.name ? this.parseIdent() : null

  this.parseFunctionParams(node)
  this.parseFunctionBody(node, allowExpressionBody, false, forInit)

  this.yieldPos = oldYieldPos
  this.awaitPos = oldAwaitPos
  this.awaitIdentPos = oldAwaitIdentPos
  return this.finishNode(node, (statement & FUNC_STATEMENT) ? "FunctionDeclaration" : "FunctionExpression")
}

pp.parseFunctionParams = function(node) {
  this.expect(tt.parenL)
  node.params = this.parseBindingList(tt.parenR, false, this.options.ecmaVersion >= 8)
  this.checkYieldAwaitInDefaultParams()
}

// Parse a class declaration or literal (depending on the
// `isStatement` parameter).

pp.parseClass = function(node, isStatement) {
  this.next()

  // ecma-262 14.6 Class Definitions
  // A class definition is always strict mode code.
  const oldStrict = this.strict
  this.strict = true

  this.parseClassId(node, isStatement)
  this.parseClassSuper(node)
  const privateNameMap = this.enterClassBody()
  const classBody = this.startNode()
  let hadConstructor = false
  classBody.body = []
  this.expect(tt.braceL)
  while (this.type !== tt.braceR) {
    const element = this.parseClassElement(node.superClass !== null)
    if (element) {
      classBody.body.push(element)
      if (element.type === "MethodDefinition" && element.kind === "constructor") {
        if (hadConstructor) this.raiseRecoverable(element.start, "Duplicate constructor in the same class")
        hadConstructor = true
      } else if (element.key && element.key.type === "PrivateIdentifier" && isPrivateNameConflicted(privateNameMap, element)) {
        this.raiseRecoverable(element.key.start, `Identifier '#${element.key.name}' has already been declared`)
      }
    }
  }
  this.strict = oldStrict
  this.next()
  node.body = this.finishNode(classBody, "ClassBody")
  this.exitClassBody()
  return this.finishNode(node, isStatement ? "ClassDeclaration" : "ClassExpression")
}

pp.parseClassElement = function(constructorAllowsSuper) {
  if (this.eat(tt.semi)) return null

  const ecmaVersion = this.options.ecmaVersion
  const node = this.startNode()
  let keyName = ""
  let isGenerator = false
  let isAsync = false
  let kind = "method"
  let isStatic = false

  if (this.eatContextual("static")) {
    // Parse static init block
    if (ecmaVersion >= 13 && this.eat(tt.braceL)) {
      this.parseClassStaticBlock(node)
      return node
    }
    if (this.isClassElementNameStart() || this.type === tt.star) {
      isStatic = true
    } else {
      keyName = "static"
    }
  }
  node.static = isStatic
  if (!keyName && ecmaVersion >= 8 && this.eatContextual("async")) {
    if ((this.isClassElementNameStart() || this.type === tt.star) && !this.canInsertSemicolon()) {
      isAsync = true
    } else {
      keyName = "async"
    }
  }
  if (!keyName && (ecmaVersion >= 9 || !isAsync) && this.eat(tt.star)) {
    isGenerator = true
  }
  if (!keyName && !isAsync && !isGenerator) {
    const lastValue = this.value
    if (this.eatContextual("get") || this.eatContextual("set")) {
      if (this.isClassElementNameStart()) {
        kind = lastValue
      } else {
        keyName = lastValue
      }
    }
  }

  // Parse element name
  if (keyName) {
    // 'async', 'get', 'set', or 'static' were not a keyword contextually.
    // The last token is any of those. Make it the element name.
    node.computed = false
    node.key = this.startNodeAt(this.lastTokStart, this.lastTokStartLoc)
    node.key.name = keyName
    this.finishNode(node.key, "Identifier")
  } else {
    this.parseClassElementName(node)
  }

  // Parse element value
  if (ecmaVersion < 13 || this.type === tt.parenL || kind !== "method" || isGenerator || isAsync) {
    const isConstructor = !node.static && checkKeyName(node, "constructor")
    const allowsDirectSuper = isConstructor && constructorAllowsSuper
    // Couldn't move this check into the 'parseClassMethod' method for backward compatibility.
    if (isConstructor && kind !== "method") this.raise(node.key.start, "Constructor can't have get/set modifier")
    node.kind = isConstructor ? "constructor" : kind
    this.parseClassMethod(node, isGenerator, isAsync, allowsDirectSuper)
  } else {
    this.parseClassField(node)
  }

  return node
}

pp.isClassElementNameStart = function() {
  return (
    this.type === tt.name ||
    this.type === tt.privateId ||
    this.type === tt.num ||
    this.type === tt.string ||
    this.type === tt.bracketL ||
    this.type.keyword
  )
}

pp.parseClassElementName = function(element) {
  if (this.type === tt.privateId) {
    if (this.value === "constructor") {
      this.raise(this.start, "Classes can't have an element named '#constructor'")
    }
    element.computed = false
    element.key = this.parsePrivateIdent()
  } else {
    this.parsePropertyName(element)
  }
}

pp.parseClassMethod = function(method, isGenerator, isAsync, allowsDirectSuper) {
  // Check key and flags
  const key = method.key
  if (method.kind === "constructor") {
    if (isGenerator) this.raise(key.start, "Constructor can't be a generator")
    if (isAsync) this.raise(key.start, "Constructor can't be an async method")
  } else if (method.static && checkKeyName(method, "prototype")) {
    this.raise(key.start, "Classes may not have a static property named prototype")
  }

  // Parse value
  const value = method.value = this.parseMethod(isGenerator, isAsync, allowsDirectSuper)

  // Check value
  if (method.kind === "get" && value.params.length !== 0)
    this.raiseRecoverable(value.start, "getter should have no params")
  if (method.kind === "set" && value.params.length !== 1)
    this.raiseRecoverable(value.start, "setter should have exactly one param")
  if (method.kind === "set" && value.params[0].type === "RestElement")
    this.raiseRecoverable(value.params[0].start, "Setter cannot use rest params")

  return this.finishNode(method, "MethodDefinition")
}

pp.parseClassField = function(field) {
  if (checkKeyName(field, "constructor")) {
    this.raise(field.key.start, "Classes can't have a field named 'constructor'")
  } else if (field.static && checkKeyName(field, "prototype")) {
    this.raise(field.key.start, "Classes can't have a static field named 'prototype'")
  }

  if (this.eat(tt.eq)) {
    // To raise SyntaxError if 'arguments' exists in the initializer.
    this.enterScope(SCOPE_CLASS_FIELD_INIT | SCOPE_SUPER)
    field.value = this.parseMaybeAssign()
    this.exitScope()
  } else {
    field.value = null
  }
  this.semicolon()

  return this.finishNode(field, "PropertyDefinition")
}

pp.parseClassStaticBlock = function(node) {
  node.body = []

  let oldLabels = this.labels
  this.labels = []
  this.enterScope(SCOPE_CLASS_STATIC_BLOCK | SCOPE_SUPER)
  while (this.type !== tt.braceR) {
    let stmt = this.parseStatement(null)
    node.body.push(stmt)
  }
  this.next()
  this.exitScope()
  this.labels = oldLabels

  return this.finishNode(node, "StaticBlock")
}

pp.parseClassId = function(node, isStatement) {
  if (this.type === tt.name) {
    node.id = this.parseIdent()
    if (isStatement)
      this.checkLValSimple(node.id, BIND_LEXICAL, false)
  } else {
    if (isStatement === true)
      this.unexpected()
    node.id = null
  }
}

pp.parseClassSuper = function(node) {
  node.superClass = this.eat(tt._extends) ? this.parseExprSubscripts(null, false) : null
}

pp.enterClassBody = function() {
  const element = {declared: Object.create(null), used: []}
  this.privateNameStack.push(element)
  return element.declared
}

pp.exitClassBody = function() {
  const {declared, used} = this.privateNameStack.pop()
  if (!this.options.checkPrivateFields) return
  const len = this.privateNameStack.length
  const parent = len === 0 ? null : this.privateNameStack[len - 1]
  for (let i = 0; i < used.length; ++i) {
    const id = used[i]
    if (!hasOwn(declared, id.name)) {
      if (parent) {
        parent.used.push(id)
      } else {
        this.raiseRecoverable(id.start, `Private field '#${id.name}' must be declared in an enclosing class`)
      }
    }
  }
}

function isPrivateNameConflicted(privateNameMap, element) {
  const name = element.key.name
  const curr = privateNameMap[name]

  let next = "true"
  if (element.type === "MethodDefinition" && (element.kind === "get" || element.kind === "set")) {
    next = (element.static ? "s" : "i") + element.kind
  }

  // `class { get #a(){}; static set #a(_){} }` is also conflict.
  if (
    curr === "iget" && next === "iset" ||
    curr === "iset" && next === "iget" ||
    curr === "sget" && next === "sset" ||
    curr === "sset" && next === "sget"
  ) {
    privateNameMap[name] = "true"
    return false
  } else if (!curr) {
    privateNameMap[name] = next
    return false
  } else {
    return true
  }
}

function checkKeyName(node, name) {
  const {computed, key} = node
  return !computed && (
    key.type === "Identifier" && key.name === name ||
    key.type === "Literal" && key.value === name
  )
}

// Parses module export declaration.

pp.parseExportAllDeclaration = function(node, exports) {
  if (this.options.ecmaVersion >= 11) {
    if (this.eatContextual("as")) {
      node.exported = this.parseModuleExportName()
      this.checkExport(exports, node.exported, this.lastTokStart)
    } else {
      node.exported = null
    }
  }
  this.expectContextual("from")
  if (this.type !== tt.string) this.unexpected()
  node.source = this.parseExprAtom()
  if (this.options.ecmaVersion >= 16)
    node.attributes = this.parseWithClause()
  this.semicolon()
  return this.finishNode(node, "ExportAllDeclaration")
}

pp.parseExport = function(node, exports) {
  this.next()
  // export * from '...'
  if (this.eat(tt.star)) {
    return this.parseExportAllDeclaration(node, exports)
  }
  if (this.eat(tt._default)) { // export default ...
    this.checkExport(exports, "default", this.lastTokStart)
    node.declaration = this.parseExportDefaultDeclaration()
    return this.finishNode(node, "ExportDefaultDeclaration")
  }
  // export var|const|let|function|class ...
  if (this.shouldParseExportStatement()) {
    node.declaration = this.parseExportDeclaration(node)
    if (node.declaration.type === "VariableDeclaration")
      this.checkVariableExport(exports, node.declaration.declarations)
    else
      this.checkExport(exports, node.declaration.id, node.declaration.id.start)
    node.specifiers = []
    node.source = null
    if (this.options.ecmaVersion >= 16)
      node.attributes = []
  } else { // export { x, y as z } [from '...']
    node.declaration = null
    node.specifiers = this.parseExportSpecifiers(exports)
    if (this.eatContextual("from")) {
      if (this.type !== tt.string) this.unexpected()
      node.source = this.parseExprAtom()
      if (this.options.ecmaVersion >= 16)
        node.attributes = this.parseWithClause()
    } else {
      for (let spec of node.specifiers) {
        // check for keywords used as local names
        this.checkUnreserved(spec.local)
        // check if export is defined
        this.checkLocalExport(spec.local)

        if (spec.local.type === "Literal") {
          this.raise(spec.local.start, "A string literal cannot be used as an exported binding without `from`.")
        }
      }

      node.source = null
      if (this.options.ecmaVersion >= 16)
        node.attributes = []
    }
    this.semicolon()
  }
  return this.finishNode(node, "ExportNamedDeclaration")
}

pp.parseExportDeclaration = function(node) {
  return this.parseStatement(null)
}

pp.parseExportDefaultDeclaration = function() {
  let isAsync
  if (this.type === tt._function || (isAsync = this.isAsyncFunction())) {
    let fNode = this.startNode()
    this.next()
    if (isAsync) this.next()
    return this.parseFunction(fNode, FUNC_STATEMENT | FUNC_NULLABLE_ID, false, isAsync)
  } else if (this.type === tt._class) {
    let cNode = this.startNode()
    return this.parseClass(cNode, "nullableID")
  } else {
    let declaration = this.parseMaybeAssign()
    this.semicolon()
    return declaration
  }
}

pp.checkExport = function(exports, name, pos) {
  if (!exports) return
  if (typeof name !== "string")
    name = name.type === "Identifier" ? name.name : name.value
  if (hasOwn(exports, name))
    this.raiseRecoverable(pos, "Duplicate export '" + name + "'")
  exports[name] = true
}

pp.checkPatternExport = function(exports, pat) {
  let type = pat.type
  if (type === "Identifier")
    this.checkExport(exports, pat, pat.start)
  else if (type === "ObjectPattern")
    for (let prop of pat.properties)
      this.checkPatternExport(exports, prop)
  else if (type === "ArrayPattern")
    for (let elt of pat.elements) {
      if (elt) this.checkPatternExport(exports, elt)
    }
  else if (type === "Property")
    this.checkPatternExport(exports, pat.value)
  else if (type === "AssignmentPattern")
    this.checkPatternExport(exports, pat.left)
  else if (type === "RestElement")
    this.checkPatternExport(exports, pat.argument)
}

pp.checkVariableExport = function(exports, decls) {
  if (!exports) return
  for (let decl of decls)
    this.checkPatternExport(exports, decl.id)
}

pp.shouldParseExportStatement = function() {
  return this.type.keyword === "var" ||
    this.type.keyword === "const" ||
    this.type.keyword === "class" ||
    this.type.keyword === "function" ||
    this.isLet() ||
    this.isAsyncFunction()
}

// Parses a comma-separated list of module exports.

pp.parseExportSpecifier = function(exports) {
  let node = this.startNode()
  node.local = this.parseModuleExportName()

  node.exported = this.eatContextual("as") ? this.parseModuleExportName() : node.local
  this.checkExport(
    exports,
    node.exported,
    node.exported.start
  )

  return this.finishNode(node, "ExportSpecifier")
}

pp.parseExportSpecifiers = function(exports) {
  let nodes = [], first = true
  // export { x, y as z } [from '...']
  this.expect(tt.braceL)
  while (!this.eat(tt.braceR)) {
    if (!first) {
      this.expect(tt.comma)
      if (this.afterTrailingComma(tt.braceR)) break
    } else first = false

    nodes.push(this.parseExportSpecifier(exports))
  }
  return nodes
}

// Parses import declaration.

pp.parseImport = function(node) {
  this.next()

  // import '...'
  if (this.type === tt.string) {
    node.specifiers = empty
    node.source = this.parseExprAtom()
  } else {
    node.specifiers = this.parseImportSpecifiers()
    this.expectContextual("from")
    node.source = this.type === tt.string ? this.parseExprAtom() : this.unexpected()
  }
  if (this.options.ecmaVersion >= 16)
    node.attributes = this.parseWithClause()
  this.semicolon()
  return this.finishNode(node, "ImportDeclaration")
}

// Parses a comma-separated list of module imports.

pp.parseImportSpecifier = function() {
  let node = this.startNode()
  node.imported = this.parseModuleExportName()

  if (this.eatContextual("as")) {
    node.local = this.parseIdent()
  } else {
    this.checkUnreserved(node.imported)
    node.local = node.imported
  }
  this.checkLValSimple(node.local, BIND_LEXICAL)

  return this.finishNode(node, "ImportSpecifier")
}

pp.parseImportDefaultSpecifier = function() {
  // import defaultObj, { x, y as z } from '...'
  let node = this.startNode()
  node.local = this.parseIdent()
  this.checkLValSimple(node.local, BIND_LEXICAL)
  return this.finishNode(node, "ImportDefaultSpecifier")
}

pp.parseImportNamespaceSpecifier = function() {
  let node = this.startNode()
  this.next()
  this.expectContextual("as")
  node.local = this.parseIdent()
  this.checkLValSimple(node.local, BIND_LEXICAL)
  return this.finishNode(node, "ImportNamespaceSpecifier")
}

pp.parseImportSpecifiers = function() {
  let nodes = [], first = true
  if (this.type === tt.name) {
    nodes.push(this.parseImportDefaultSpecifier())
    if (!this.eat(tt.comma)) return nodes
  }
  if (this.type === tt.star) {
    nodes.push(this.parseImportNamespaceSpecifier())
    return nodes
  }
  this.expect(tt.braceL)
  while (!this.eat(tt.braceR)) {
    if (!first) {
      this.expect(tt.comma)
      if (this.afterTrailingComma(tt.braceR)) break
    } else first = false

    nodes.push(this.parseImportSpecifier())
  }
  return nodes
}

pp.parseWithClause = function() {
  let nodes = []
  if (!this.eat(tt._with)) {
    return nodes
  }
  this.expect(tt.braceL)
  const attributeKeys = {}
  let first = true
  while (!this.eat(tt.braceR)) {
    if (!first) {
      this.expect(tt.comma)
      if (this.afterTrailingComma(tt.braceR)) break
    } else first = false

    const attr = this.parseImportAttribute()
    const keyName = attr.key.type === "Identifier" ? attr.key.name : attr.key.value
    if (hasOwn(attributeKeys, keyName))
      this.raiseRecoverable(attr.key.start, "Duplicate attribute key '" + keyName + "'")
    attributeKeys[keyName] = true
    nodes.push(attr)
  }
  return nodes
}

pp.parseImportAttribute = function() {
  const node = this.startNode()
  node.key = this.type === tt.string ? this.parseExprAtom() : this.parseIdent(this.options.allowReserved !== "never")
  this.expect(tt.colon)
  if (this.type !== tt.string) {
    this.unexpected()
  }
  node.value = this.parseExprAtom()
  return this.finishNode(node, "ImportAttribute")
}

pp.parseModuleExportName = function() {
  if (this.options.ecmaVersion >= 13 && this.type === tt.string) {
    const stringLiteral = this.parseLiteral(this.value)
    if (loneSurrogate.test(stringLiteral.value)) {
      this.raise(stringLiteral.start, "An export name cannot include a lone surrogate.")
    }
    return stringLiteral
  }
  return this.parseIdent(true)
}

// Set `ExpressionStatement#directive` property for directive prologues.
pp.adaptDirectivePrologue = function(statements) {
  for (let i = 0; i < statements.length && this.isDirectiveCandidate(statements[i]); ++i) {
    statements[i].directive = statements[i].expression.raw.slice(1, -1)
  }
}
pp.isDirectiveCandidate = function(statement) {
  return (
    this.options.ecmaVersion >= 5 &&
    statement.type === "ExpressionStatement" &&
    statement.expression.type === "Literal" &&
    typeof statement.expression.value === "string" &&
    // Reject parenthesized strings.
    (this.input[statement.start] === "\"" || this.input[statement.start] === "'")
  )
}
