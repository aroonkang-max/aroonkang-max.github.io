import sys
ex=open(sys.argv[1]).read().strip()
s=open('index.src.html').read().replace('__EXAMPLE__', ex)
open('page.html','w').write(s)
head='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>'
open('index.html','w').write(head+s+'</body></html>')
