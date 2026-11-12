import { snippetCompletion as snip } from '@codemirror/autocomplete';

// Common LaTeX commands: [name, detail, snippet?]
const COMMANDS = [
  ['section', 'secção', 'section{${}}'], ['subsection', '', 'subsection{${}}'], ['subsubsection', '', 'subsubsection{${}}'],
  ['chapter', 'capítulo', 'chapter{${}}'], ['part', '', 'part{${}}'], ['paragraph', '', 'paragraph{${}}'],
  ['section*', '', 'section*{${}}'], ['chapter*', '', 'chapter*{${}}'],
  ['label', '', 'label{${}}'], ['ref', 'referência', 'ref{${}}'], ['eqref', '', 'eqref{${}}'], ['pageref', '', 'pageref{${}}'],
  ['autoref', '', 'autoref{${}}'], ['cref', '', 'cref{${}}'], ['Cref', '', 'Cref{${}}'],
  ['cite', 'citação', 'cite{${}}'], ['citep', '', 'citep{${}}'], ['citet', '', 'citet{${}}'], ['parencite', '', 'parencite{${}}'],
  ['textcite', '', 'textcite{${}}'], ['autocite', '', 'autocite{${}}'], ['footcite', '', 'footcite{${}}'], ['nocite', '', 'nocite{${}}'],
  ['textbf', 'negrito', 'textbf{${}}'], ['textit', 'itálico', 'textit{${}}'], ['emph', 'ênfase', 'emph{${}}'],
  ['underline', '', 'underline{${}}'], ['texttt', 'mono', 'texttt{${}}'], ['textsc', '', 'textsc{${}}'], ['textsf', '', 'textsf{${}}'],
  ['textrm', '', 'textrm{${}}'], ['textsuperscript', '', 'textsuperscript{${}}'], ['textsubscript', '', 'textsubscript{${}}'],
  ['footnote', 'nota de rodapé', 'footnote{${}}'], ['url', '', 'url{${}}'], ['href', '', 'href{${url}}{${texto}}'],
  ['includegraphics', 'imagem', 'includegraphics[width=${0.8}\\linewidth]{${}}'], ['caption', 'legenda', 'caption{${}}'],
  ['input', '', 'input{${}}'], ['include', '', 'include{${}}'], ['includeonly', '', 'includeonly{${}}'],
  ['usepackage', '', 'usepackage{${}}'], ['documentclass', '', 'documentclass{${article}}'],
  ['title', '', 'title{${}}'], ['author', '', 'author{${}}'], ['date', '', 'date{${}}'], ['maketitle'], ['tableofcontents'],
  ['listoffigures'], ['listoftables'], ['appendix'], ['newpage'], ['clearpage'], ['cleardoublepage'], ['pagebreak'], ['linebreak'],
  ['noindent'], ['indent'], ['centering'], ['raggedright'], ['raggedleft'], ['par'], ['hfill'], ['vfill'], ['today'],
  ['vspace', '', 'vspace{${}}'], ['hspace', '', 'hspace{${}}'], ['smallskip'], ['medskip'], ['bigskip'],
  ['item'], ['bibliography', '', 'bibliography{${refs}}'], ['bibliographystyle', '', 'bibliographystyle{${plain}}'],
  ['printbibliography'], ['addbibresource', '', 'addbibresource{${refs.bib}}'],
  ['newcommand', '', 'newcommand{\\${nome}}[${1}]{${}}'], ['renewcommand', '', 'renewcommand{\\${nome}}{${}}'],
  ['newenvironment', '', 'newenvironment{${nome}}{${}}{${}}'], ['DeclareMathOperator', '', 'DeclareMathOperator{\\${op}}{${}}'],
  ['setlength', '', 'setlength{\\${}}{${}}'], ['setcounter', '', 'setcounter{${}}{${}}'],
  ['frac', 'fração', 'frac{${}}{${}}'], ['dfrac', '', 'dfrac{${}}{${}}'], ['tfrac', '', 'tfrac{${}}{${}}'], ['sqrt', 'raiz', 'sqrt{${}}'],
  ['sum', '', 'sum_{${i=1}}^{${n}}'], ['prod', '', 'prod_{${}}^{${}}'], ['int', '', 'int_{${a}}^{${b}}'], ['iint'], ['oint'],
  ['lim', '', 'lim_{${x \\to \\infty}}'], ['infty'], ['partial'], ['nabla'], ['cdot'], ['cdots'], ['ldots'], ['vdots'], ['ddots'],
  ['times'], ['div'], ['pm'], ['mp'], ['leq'], ['geq'], ['neq'], ['approx'], ['equiv'], ['sim'], ['simeq'], ['propto'],
  ['in'], ['notin'], ['subset'], ['subseteq'], ['supset'], ['cup'], ['cap'], ['emptyset'], ['forall'], ['exists'],
  ['rightarrow'], ['leftarrow'], ['Rightarrow'], ['Leftarrow'], ['Leftrightarrow'], ['mapsto'], ['to'],
  ['alpha'], ['beta'], ['gamma'], ['Gamma'], ['delta'], ['Delta'], ['epsilon'], ['varepsilon'], ['zeta'], ['eta'], ['theta'], ['Theta'],
  ['iota'], ['kappa'], ['lambda'], ['Lambda'], ['mu'], ['nu'], ['xi'], ['Xi'], ['pi'], ['Pi'], ['rho'], ['sigma'], ['Sigma'],
  ['tau'], ['upsilon'], ['phi'], ['varphi'], ['Phi'], ['chi'], ['psi'], ['Psi'], ['omega'], ['Omega'],
  ['mathbb', '', 'mathbb{${}}'], ['mathcal', '', 'mathcal{${}}'], ['mathbf', '', 'mathbf{${}}'], ['mathrm', '', 'mathrm{${}}'],
  ['mathit', '', 'mathit{${}}'], ['boldsymbol', '', 'boldsymbol{${}}'], ['text', '', 'text{${}}'], ['operatorname', '', 'operatorname{${}}'],
  ['hat', '', 'hat{${}}'], ['bar', '', 'bar{${}}'], ['vec', '', 'vec{${}}'], ['tilde', '', 'tilde{${}}'], ['dot', '', 'dot{${}}'],
  ['overline', '', 'overline{${}}'], ['underbrace', '', 'underbrace{${}}_{${}}'], ['overbrace', '', 'overbrace{${}}^{${}}'],
  ['left(', '', 'left( ${} \\right)'], ['left[', '', 'left[ ${} \\right]'], ['left\\{', '', 'left\\\\{ ${} \\right\\\\}'],
  ['log'], ['ln'], ['exp'], ['sin'], ['cos'], ['tan'], ['max'], ['min'], ['arg'], ['det'],
  ['quad'], ['qquad'], ['hline'], ['toprule'], ['midrule'], ['bottomrule'], ['cline', '', 'cline{${1-2}}'],
  ['multicolumn', '', 'multicolumn{${2}}{${c}}{${}}'], ['multirow', '', 'multirow{${2}}{*}{${}}'],
  ['tikz', '', 'tikz{${}}'], ['draw'], ['node'], ['SI', '', 'SI{${}}{${}}'], ['si', '', 'si{${}}'], ['num', '', 'num{${}}'],
  ['acrshort', '', 'acrshort{${}}'], ['gls', '', 'gls{${}}'], ['todo', '', 'todo{${}}'],
];

const ENVIRONMENTS = [
  ['itemize', '\t\\item ${}'], ['enumerate', '\t\\item ${}'], ['description', '\t\\item[${}] '],
  ['figure', '\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{${}}\n\t\\caption{${}}\n\t\\label{fig:${}}', '[htbp]'],
  ['table', '\t\\centering\n\t\\caption{${}}\n\t\\label{tab:${}}\n\t\\begin{tabular}{${lc}}\n\t\t\\hline\n\t\t${} \\\\\n\t\t\\hline\n\t\\end{tabular}', '[htbp]'],
  ['tabular', '\t${} \\\\', '{${lc}}'], ['equation', '\t${}'], ['equation*', '\t${}'], ['align', '\t${} &= ${} \\\\'],
  ['align*', '\t${} &= ${}'], ['gather', '\t${}'], ['multline', '\t${}'], ['split', '\t${}'], ['cases', '\t${} & ${} \\\\'],
  ['matrix', '\t${}'], ['pmatrix', '\t${}'], ['bmatrix', '\t${}'], ['center', '\t${}'], ['quote', '\t${}'], ['quotation', '\t${}'],
  ['abstract', '\t${}'], ['minipage', '\t${}', '{${0.48}\\linewidth}'], ['verbatim', '${}'], ['lstlisting', '${}'], ['minted', '${}', '{${python}}'],
  ['theorem', '\t${}'], ['lemma', '\t${}'], ['proof', '\t${}'], ['definition', '\t${}'], ['example', '\t${}'], ['remark', '\t${}'],
  ['tikzpicture', '\t${}'], ['frame', '\t\\frametitle{${}}\n\t${}'], ['columns', '\t\\column{0.5\\textwidth}\n\t${}'],
  ['subfigure', '\t${}', '{${0.48}\\linewidth}'], ['thebibliography', '\t\\bibitem{${}} ${}', '{99}'], ['document', '${}'],
];

const escapeSnippet = (s) => s; // snippets above are already escaped

function commandOptions(extraCommands = []) {
  const opts = COMMANDS.map(([name, detail, tpl]) =>
    tpl ? snip('\\' + escapeSnippet(tpl), { label: '\\' + name, detail: detail || '', type: 'function' })
        : { label: '\\' + name, detail: detail || '', type: 'keyword' });
  for (const c of extraCommands) opts.push({ label: '\\' + c, detail: 'definido no projeto', type: 'variable' });
  opts.push(snip('\\begin{${env}}\n\t${}\n\\end{${env}}', { label: '\\begin', detail: 'ambiente', type: 'keyword' }));
  return opts;
}

function envOptions(extraEnvs = []) {
  const all = [...ENVIRONMENTS, ...extraEnvs.map((e) => [e, '\t${}'])];
  return all.map(([name, body, args = '']) => ({
    label: name,
    type: 'type',
    detail: 'ambiente',
    apply: (view, completion, from, to) => {
      // Replace "\begin{xxx" with full environment snippet
      const line = view.state.doc.lineAt(from);
      const indent = (line.text.match(/^\s*/) || [''])[0];
      const after = view.state.doc.sliceString(to, Math.min(to + 1, line.to));
      const closeLen = after === '}' ? 1 : 0;
      const tpl = `${name}}${args}\n${body.split('\n').map((l) => indent + l).join('\n')}\n${indent}\\end{${name}}`;
      snip(tpl, { label: name }).apply(view, completion, from, to + closeLen);
    },
  }));
}

export function latexCompletion(getSymbols) {
  return (context) => {
    const sym = getSymbols() || { labels: [], citations: [], commands: [], environments: [] };
    // \ref{..., \cite{a,b...
    const arg = context.matchBefore(/\\([A-Za-z]*(?:ref|cite[a-z]*|Cref|cref|autoref|pageref|eqref)|begin|end|input|include|includegraphics(?:\[[^\]]*\])?)\*?\{[^}]*$/);
    if (arg) {
      const cmd = arg.text.match(/^\\([A-Za-z]+)/)[1];
      const braceAt = arg.text.indexOf('{');
      const inside = arg.text.slice(braceAt + 1);
      const lastComma = inside.lastIndexOf(',');
      const from = arg.from + braceAt + 1 + (lastComma + 1);
      if (/cite/i.test(cmd)) {
        return { from, options: sym.citations.map((c) => ({ label: c.key, detail: c.type, info: c.title, type: 'text' })), validFor: /^[^,}\s]*$/ };
      }
      if (/ref$/i.test(cmd)) {
        return { from, options: sym.labels.map((l) => ({ label: l.key, detail: `${l.file}:${l.line}`, type: 'constant' })), validFor: /^[^,}\s]*$/ };
      }
      if (cmd === 'begin') return { from, options: envOptions(sym.environments), validFor: /^[\w*]*$/ };
      if (cmd === 'end') {
        return { from, options: [...ENVIRONMENTS.map((e) => e[0]), ...sym.environments].map((e) => ({ label: e, type: 'type' })), validFor: /^[\w*]*$/ };
      }
      if (sym.files) {
        const exts = cmd.startsWith('includegraphics') ? /\.(png|jpe?g|pdf|eps|svg)$/i : /\.tex$/i;
        return {
          from,
          options: sym.files.filter((f) => exts.test(f)).map((f) => ({ label: cmd.startsWith('include') && !cmd.startsWith('includegraphics') ? f.replace(/\.tex$/, '') : f, type: 'text' })),
        };
      }
      return null;
    }
    const word = context.matchBefore(/\\[A-Za-z@*]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    return { from: word.from, options: commandOptions(sym.commands), validFor: /^\\[A-Za-z@*(\[{]*$/ };
  };
}
