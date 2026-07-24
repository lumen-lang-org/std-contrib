// A scalar/string-friendly C surface over Poppler's C++ API.
//
// poppler-cpp deals in objects, std::string, and poppler::ustring (UTF-16
// internally). The Lumen FFI marshals only scalars and C strings, so this shim
// keeps the open document behind a global, converts text to UTF-8, and hands
// back plain `const char *`.
//
// Build:
//   c++ -c poppler_shim.cpp -I/usr/include/poppler/cpp -o poppler_shim.o
// macOS (Homebrew):
//   c++ -c poppler_shim.cpp -I/opt/homebrew/include/poppler/cpp -o poppler_shim.o

#include <poppler-document.h>
#include <poppler-page.h>
#include <poppler-global.h>
#include <poppler-version.h>

#include <string>
#include <cstring>

namespace {

// The one document this shim manages, mirroring the SQLite shim's single
// connection: the FFI has no handle type to pass back and forth.
poppler::document *g_doc = nullptr;

// Owns the most recent text result so the pointer handed to Lumen stays valid
// until the next call. A document's text can be megabytes, so this grows rather
// than living in a fixed buffer as SQLite's does.
std::string g_text;
std::string g_error;

const char *hold(const std::string &s) {
    g_text = s;
    return g_text.c_str();
}

const char *fail(const char *message) {
    g_error = message;
    g_text.clear();
    return g_text.c_str();
}

// poppler::ustring is UTF-16; to_utf8 returns a byte_array, which is a
// std::vector<char> and is NOT null-terminated.
std::string utf8Of(const poppler::ustring &u) {
    poppler::byte_array bytes = u.to_utf8();
    return std::string(bytes.begin(), bytes.end());
}

}  // namespace

extern "C" {

// Open a document. Returns 0 on success, and a negative code otherwise:
//   -1 the file could not be loaded at all (missing, or not a PDF)
//   -2 the document is encrypted and needs a password
int pdf_open(const char *path) {
    if (g_doc) {
        delete g_doc;
        g_doc = nullptr;
    }
    g_error.clear();
    g_doc = poppler::document::load_from_file(path);
    if (!g_doc) {
        g_error = "could not load the document";
        return -1;
    }
    if (g_doc->is_encrypted()) {
        delete g_doc;
        g_doc = nullptr;
        g_error = "the document is encrypted";
        return -2;
    }
    return 0;
}

// Open an encrypted document with a password. Same return codes as pdf_open.
int pdf_open_with_password(const char *path, const char *password) {
    if (g_doc) {
        delete g_doc;
        g_doc = nullptr;
    }
    g_error.clear();
    const std::string owner;
    g_doc = poppler::document::load_from_file(path, owner, std::string(password));
    if (!g_doc) {
        g_error = "could not load the document — wrong password, or not a PDF";
        return -1;
    }
    return 0;
}

int pdf_pages(void) {
    if (!g_doc) return -1;
    return g_doc->pages();
}

// Whole-document text, pages joined in order.
//
// `physical` selects Poppler's layout-preserving mode, which keeps a page's
// horizontal arrangement so side-by-side columns do not run together. Zero
// takes reading order as Poppler recovers it.
const char *pdf_text(int physical) {
    if (!g_doc) return fail("no document is open");
    poppler::page::text_layout_enum layout =
        physical ? poppler::page::physical_layout : poppler::page::raw_order_layout;
    std::string all;
    const int n = g_doc->pages();
    for (int i = 0; i < n; ++i) {
        poppler::page *p = g_doc->create_page(i);
        if (!p) continue;
        all += utf8Of(p->text(poppler::rectf(), layout));
        all += "\n";
        delete p;
    }
    return hold(all);
}

// One page's text. Pages are numbered from 1, matching how a reader counts them
// and how every other API in this package does; poppler counts from 0.
const char *pdf_page_text(int page, int physical) {
    if (!g_doc) return fail("no document is open");
    if (page < 1 || page > g_doc->pages()) return fail("page out of range");
    poppler::page::text_layout_enum layout =
        physical ? poppler::page::physical_layout : poppler::page::raw_order_layout;
    poppler::page *p = g_doc->create_page(page - 1);
    if (!p) return fail("the page could not be read");
    std::string text = utf8Of(p->text(poppler::rectf(), layout));
    delete p;
    return hold(text);
}

// A field of the document information dictionary ("Title", "Author",
// "Subject", "Keywords", "Creator", "Producer"). Absent fields yield "".
const char *pdf_info(const char *key) {
    if (!g_doc) return fail("no document is open");
    return hold(utf8Of(g_doc->info_key(std::string(key))));
}

// Creation and modification times as Unix seconds, or 0 when absent.
//
// Poppler reports an absent date as time_t(-1); that is normalised to 0 here so
// callers test one thing rather than two, and so an absent date never sorts
// before a real one.
static long dateOrZero(const char *key) {
    if (!g_doc) return 0;
    time_t t = g_doc->info_date_t(std::string(key));
    if (t == static_cast<time_t>(-1)) return 0;
    return static_cast<long>(t);
}

long pdf_created(void) {
    return dateOrZero("CreationDate");
}

long pdf_modified(void) {
    return dateOrZero("ModDate");
}

// The reason the last call failed, or "".
const char *pdf_error(void) {
    return g_error.c_str();
}

// Poppler's version, which also serves as proof the library linked.
const char *pdf_version(void) {
    return hold(poppler::version_string());
}

void pdf_close(void) {
    if (g_doc) {
        delete g_doc;
        g_doc = nullptr;
    }
    g_text.clear();
    g_error.clear();
}

}  // extern "C"
