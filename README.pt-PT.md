# LaTeX Local

Uma plataforma tipo Overleaf que corre só na tua máquina: editor + PDF lado a lado, SyncTeX, autocompletar e gestor de packages.

## Arrancar

```bash
./run.sh            # abre http://127.0.0.1:8765  (PORT=9000 ./run.sh para mudar a porta)
```

Recomendado (uma vez): `sudo apt install latexmk texlive-xetex biber texlive-lang-portuguese`
(sem `latexmk` a plataforma corre o motor + bibtex/biber manualmente.)

Os projetos ficam em `projects/<id>/`, como pastas normais; os ficheiros gerados ficam em `projects/<id>/.build/`.

## Atalhos

| Atalho | Ação |
|---|---|
| Ctrl+S | Gravar tudo e compilar |
| Ctrl+Enter | Ir do cursor para o PDF (SyncTeX) |
| Duplo clique no PDF | Ir para a linha no código |
| Ctrl+Espaço | Autocompletar (`\cite{`, `\ref{`, `\begin{`, comandos) |
| Ctrl+B / Ctrl+I | `\textbf{}` / `\textit{}` |
| Ctrl+/ | Comentar linha |
| Ctrl+F | Procurar/substituir |

Clique direito na árvore de ficheiros: definir ficheiro principal, mudar nome, apagar. Arrastar ficheiros para a árvore: carregar.

## Importar projetos

Na página inicial, em **Import / Importar**:
- **Ficheiro ZIP**, por exemplo uma exportação do Overleaf. Se o ZIP tiver uma única pasta de topo, essa pasta é removida.
- **Pasta**, escolhida no browser, ou arrastada para a zona de largar.
- **Pasta do disco**, indicando um caminho como `~/Documentos/tese`. A pasta é copiada; o original não é alterado.

Ao importar, a plataforma deteta o ficheiro principal (`\documentclass`), o motor (com fontspec/polyglossia usa xelatex) e a língua do corretor (opção do babel ou do polyglossia). Os ficheiros auxiliares (`.aux`, `.log`…) e o `.git` não são copiados.

Num projeto aberto, o botão ⬆📁 da árvore de ficheiros carrega uma pasta inteira, e também se pode arrastar uma pasta para a árvore.

## Interface e corretor ortográfico

- Língua da interface: o botão **EN | PT** na barra de topo. O inglês é a língua por omissão.
- O corretor ortográfico usa o Hunspell. A língua escolhe-se por projeto no seletor "✓ Português (Portugal)" da barra do editor.
  - Clique direito numa palavra sublinhada mostra sugestões, "Adicionar ao dicionário" e "Ignorar".
  - Só o texto é verificado: comandos, matemática, `\cite`, `\ref`, comentários e ambientes de código ficam de fora.
  - Para outras línguas, ir a 📦 → **Dicionários** e descarregar (cerca de 40 disponíveis). Ficam em `~/.local/share/latexlocal/dictionaries`, e as palavras pessoais em `~/.local/share/latexlocal/personal-<língua>.txt`.
- **A− / A+**: tamanho da letra do editor. **◐**: tema claro/escuro. As cores do realce têm contraste ≥ 4.5:1 nos dois temas.

## Gestor de packages (📦)

- **Em falta**: o que a última compilação não encontrou (`.sty`, `.cls`, idiomas do babel) e verificação de todos os `\usepackage` do projeto; mostra o package CTAN e o pacote Debian que o fornece.
- **Instalação sem sudo**: `tlmgr --usermode` em `~/texmf`. Primeiro em *Configuração → Inicializar ~/texmf*.
- **Instalação via apt**: usa `pkexec` (pede a password de administrador numa janela).
- **Instalados / Atualizações**: lista e atualiza packages do utilizador (tlmgr) e do sistema (apt).

## Desenvolvimento

```bash
cd backend && ../.venv/bin/python -m pytest -q     # testes
cd frontend && npm run dev                         # Vite com hot reload em :5173 (precisa do backend a correr)
```
