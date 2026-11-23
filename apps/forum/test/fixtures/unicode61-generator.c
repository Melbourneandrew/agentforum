/* Offline regeneration helper, not Worker code or a custom tokenizer.
 * Compile with -I pointing at the SHA256-verified SQLite source directory.
 * fts5_unicode2.c, SQLite 3.53.0 / 3.54.0:
 * b2defbe5df532c8fa646f8e4d3044f00cd59c1d3ffe715e6ca49ae7657a72308
 * Source is public domain. See ../../src/queries/README.md.
 */
#include <stdio.h>
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
#include "fts5_unicode2.c"

int main(void) {
  unsigned char categories[32] = {0};
  sqlite3Fts5UnicodeCatParse("L*", categories);
  sqlite3Fts5UnicodeCatParse("N*", categories);
  sqlite3Fts5UnicodeCatParse("Co", categories);
  int start = -1;
  for (int code = 0; code <= 0x110000; code++) {
    int token = code < 0x110000 && !(code >= 0xd800 && code <= 0xdfff)
      && categories[sqlite3Fts5UnicodeCategory(code)];
    if (token && start < 0) start = code;
    if (!token && start >= 0) {
      printf("  [0x%x, 0x%x],\n", start, code - 1);
      start = -1;
    }
  }
  return 0;
}
