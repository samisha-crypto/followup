#!/usr/bin/env python3
"""Converts the original Claude-artifact app (legacy/claude-artifact/followup-app.html)
into public/index.html for self-hosting. The original file is never modified, so any future
change made to the artifact can be ported by re-running:  npm run build:frontend"""
import os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
s = open(os.path.join(root, 'legacy/claude-artifact/followup-app.html'), encoding='utf-8').read()

def R(old, new):
    global s
    n = s.count(old)
    if n != 1: sys.exit(f'PATCH FAILED ({n} matches): {old[:70]!r}')
    s = s.replace(old, new)
def RA(old, new, expected=None):
    global s
    n = s.count(old)
    if not n or (expected is not None and n != expected):
        sys.exit(f'PATCH FAILED ({n} matches, expected {expected}): {old[:70]!r}')
    s = s.replace(old, new)
def span(a, b, new):
    global s
    i = s.index(a); j = s.index(b, i); s = s[:i] + new + s[j:]

R('own=false,joining=0,swept=0', 'own=false,joining=1,swept=0')            # accounts/membership are handled by the server
span('const gate=()=>{', 'const signupHtml=', r'''const gate=()=>{$('#top').style.display='none';$('#mobile-nav').style.display='none';$('#main').innerHTML=`<div class="c" style="max-width:420px;margin:30px auto"><div style="text-align:center"><div style="font-size:42px">✅</div><h1>FollowUp</h1><p class="m">Team projects, to-dos and follow-ups</p></div><div class="r" style="justify-content:center;margin:12px 0"><button class="${gt==='in'?'on':''}" data-act="gt" data-id="in">Log in</button><button class="${gt==='up'?'on':''}" data-act="gt" data-id="up">Sign up</button></div>${gt==='up'?'<input type="text" id="an" placeholder="Full name" style="margin-bottom:8px"><input type="text" id="ac" placeholder="Invite code (from your admin)" style="margin-bottom:8px;text-transform:uppercase"><p class="m">The very first account on a new server becomes the admin and needs no code.</p>':''}<input type="text" id="ae" placeholder="Email" autocomplete="username" style="margin-bottom:8px"><input type="password" id="ap" placeholder="Password (min 8 characters)" autocomplete="${gt==='in'?'current-password':'new-password'}"><div id="aerr" class="m" style="color:var(--er);min-height:20px;margin:6px 0"></div><button class="p" style="width:100%" data-act="${gt==='in'?'login':'signup'}">${gt==='in'?'Log in':'Create account'}</button></div>`};
''')
R("const INV_URL='https://claude.ai/artifact/9uJ5jNGcT8XUEAZxhUNe5L',msgInv=", "const INV_URL=location.origin,msgInv=")
R(r"\n2) Log in with your Claude account (create one if needed)\n3) Choose Sign up and enter invite code: ", r"\n2) Click “Sign up” and create your account\n3) Enter this invite code: ")
span('(ad?`<div class="c"><b>➕ Add a user</b>', '\n +invHtml()', '''(ad?`<div class="c"><b>➕ Create a user</b><div class="r" style="margin:8px 0"><input type="text" id="un" placeholder="Full name" class="g"><input type="text" id="ue" placeholder="Email" class="g"><input type="text" id="up" placeholder="Position / job title" class="g"><select id="ur"><option>member</option><option>admin</option><option>viewer</option></select></div><button class="p" data-act="uadd2">Create user</button><p class="m">Creates an account with a temporary password shown once (and emailed if SMTP is configured).</p><textarea id="tp" rows="4" readonly style="display:none;margin-top:8px"></textarea></div><div class="c"><b>📥 Bulk import users from Excel</b><p class="m">Upload .xlsx with Full Name, Email, Role, Position, and an optional Temporary Password. Blank passwords are generated automatically. Up to 500 rows.</p><div class="r"><button data-act="downloadUserTemplate">Download Excel template</button><input type="file" id="user-import" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"><button class="p" data-act="bulkImport">Import users</button></div><pre id="user-import-results" class="m" style="white-space:pre-wrap"></pre></div>`:'')''')
R('<button data-act="rm" data-id="${E(m.id)}">Remove</button>', '<button data-act="rpw" data-id="${E(m.id)}" title="Reset password">🔑</button><button data-act="rm" data-id="${E(m.id)}">Remove</button>')
R('<div class="c"><b>My profile & appearance</b>', '<div class="c"><b>Change password</b><div class="r" style="margin:8px 0"><input type="password" id="pw0" placeholder="Current password" class="g"><input type="password" id="pw1" placeholder="New password (min 8)" class="g"><button class="p" data-act="chpw">Update</button></div></div><div class="c"><b>My profile & appearance</b>')
RA("function todoForm(){const ls=[...new Set([...D.todolists.filter(l=>l.pid===pid).map(l=>l.title),...D.todos.filter(t=>t.pid===pid).map(t=>t.list)])];return `<div class=\"c\"><input type=\"text\" id=\"ft\" placeholder=\"To-do title\" maxlength=\"140\"><div class=\"r\" style=\"margin-top:6px\"><input type=\"text\" id=\"fl\" list=\"ll\" value=\"${E(forms.todoList||'')}\" placeholder=\"List (e.g. Planning, Launch)\" class=\"g\"><datalist id=\"ll\">${ls.map(l=>`<option value=\"${E(l)}\">`).join('')}</datalist><input type=\"date\" id=\"fd\"></div>",
    "function todoForm(){const ls=D.todolists.filter(l=>l.pid===pid);return `<div class=\"c\"><input type=\"text\" id=\"ft\" placeholder=\"To-do title\" maxlength=\"140\"><div class=\"r\" style=\"margin-top:6px\"><select id=\"fl\" class=\"g\" required><option value=\"\">Choose a to-do list</option>${ls.map(l=>`<option value=\"${E(l.id)}\"${l.id===forms.todoList?' selected':''}>${E(l.title)}</option>`).join('')}</select><input type=\"date\" id=\"fd\"></div>")
RA("<input type=\"text\" id=\"el\" class=\"g\" value=\"${E(t.list||'')}\" placeholder=\"List\"><input type=\"date\" id=\"edd\"", "<select id=\"el\" class=\"g\">${D.todolists.filter(l=>l.pid===t.pid).map(l=>`<option value=\"${E(l.id)}\"${l.id===t.listId?' selected':''}>${E(l.title)}</option>`).join('')}</select><input type=\"date\" id=\"edd\"", 2)
R("${E(t.list||'To-dos')}</span><button class=\"lk\"", "${E(D.todolists.find(l=>l.id===t.listId)?.title||t.list||'To-dos')}</span><button class=\"lk\"")
R("lists=[...new Set(tt.map(t=>t.list||'To-dos'))]", "lists=D.todolists.filter(l=>l.pid===pid)")
R("${forms.tf&&!forms.todoList?todoForm():''}", "${forms.tf&&!forms.todoList&&D.todolists.some(l=>l.pid===pid)?todoForm():''}")
R("const ls=[...new Set([...D.todolists.filter(l=>l.pid===pid).map(l=>l.title),...tt.map(t=>t.list||'To-dos')])];", "const ls=D.todolists.filter(l=>l.pid===pid);")
R("<div class=\"r\"><button class=\"p\" data-act=\"tf\">+ Add a to-do</button><button data-act=\"newList\">+ Add a to-do list</button></div>", "<div class=\"r\">${ls.length?'<button class=\"p\" data-act=\"tf\">+ Add a to-do</button>':''}<button data-act=\"newList\">+ Add a to-do list</button></div>${!ls.length?'<p class=\"m\">Create a to-do list first. To-dos always belong to a list.</p>':''}")
R("ls.map(l=>`<section class=\"list-card\"><div class=\"r\"><h2 class=\"g\">${E(l)}</h2><button data-act=\"tf\" data-list=\"${E(l)}\">+ To-do</button></div>${forms.tf&&forms.todoList===l?todoForm():''}${tt.filter(t=>(t.list||'To-dos')===l&&!t.done).map(row).join('')}${tt.filter(t=>(t.list||'To-dos')===l&&t.done).slice(0,3).map(row).join('')}</section>`)",
    "ls.map(l=>`<section class=\"list-card\"><div class=\"r\"><h2 class=\"g\">${E(l.title)}</h2><button data-act=\"tf\" data-list=\"${E(l.id)}\">+ To-do</button></div>${forms.tf&&forms.todoList===l.id?todoForm():''}${tt.filter(t=>t.listId===l.id&&!t.done).map(row).join('')}${tt.filter(t=>t.listId===l.id&&t.done).slice(0,3).map(row).join('')}</section>`)")
RA("const ls=[...new Set(tt.map(t=>t.list||'To-dos'))],hl=p.hill||{}", "const ls=D.todolists.filter(l=>l.pid===pid).map(l=>l.title),hl=p.hill||{}")
RA("list:val('#el')||'To-dos'", "listId:val('#el'),list:D.todolists.find(l=>l.id===val('#el'))?.title||''")
R("else if(a==='createList'){const title=val('#list-title');if(!title)return $('#list-title').focus();if(D.todolists.some(l=>l.pid===pid&&l.title.toLowerCase()===title.toLowerCase()))return toast('That list already exists');col_('todolists').add({pid,title,t:now}).then(()=>{forms.listCreate=false;toast('To-do list created')}).catch(fail)}",
  "else if(a==='createList'){const title=val('#list-title');if(!title)return $('#list-title').focus();if(D.todolists.some(l=>l.pid===pid&&l.title.toLowerCase()===title.toLowerCase()))return toast('That list already exists');col_('todolists').add({pid,title,t:now}).then(r=>{forms.listCreate=false;forms.tf=false;forms.todoList=r.id;toast('To-do list created')}).catch(fail)}")
R("else if(a==='tf'){forms.tf=!forms.tf;forms.todoList=forms.tf?(b.dataset.list||''):'';forms.cc={};render()}",
  "else if(a==='tf'){forms.tf=!forms.tf;forms.todoList=forms.tf?(b.dataset.list||''):'';forms.cc={};if(!D.todolists.some(l=>l.pid===pid))forms.listCreate=true;render()}")
R("else if(a==='add'){const t=val('#ft');if(!t)return $('#ft').focus();const cc=ccl(),to=$('#fa').value||me;try{const todo=await col_('todos').add({pid,title:t,list:val('#fl')||forms.todoList||'To-dos',due:$('#fd').value,to,cc,by:me,done:false,created:now,last:now,log:[],nudges:[]});[to,...cc].forEach(u=>notify(u,(u===to?'Assigned to you: ':'CC: ')+t,pid,'note',{type:'todo',id:todo.id,pid}))}catch(e){fail(e)}forms.tf=false;forms.todoList='';forms.cc={};render()}",
  "else if(a==='add'){const t=val('#ft');if(!t)return $('#ft').focus();const listId=val('#fl'),list=D.todolists.find(l=>l.id===listId&&l.pid===pid);if(!list)return toast('Choose a to-do list first');const cc=ccl(),to=$('#fa').value||me;try{const todo=await col_('todos').add({pid,title:t,listId,list:list.title,due:$('#fd').value,to,cc,by:me,done:false,created:now,last:now,log:[],nudges:[]});[to,...cc].forEach(u=>notify(u,(u===to?'Assigned to you: ':'CC: ')+t,pid,'note',{type:'todo',id:todo.id,pid}))}catch(e){fail(e)}forms.tf=false;forms.todoList='';forms.cc={};render()}")
R("const to=$('#ea').value||T.to,t=val('#et');if(!t)return;col_('todos').doc(id).update({title:t,listId:val('#el'),list:D.todolists.find(l=>l.id===val('#el'))?.title||'',due:$('#edd').value,to})",
  "const to=$('#ea').value||T.to,t=val('#et');if(!t)return;const list=D.todolists.find(l=>l.id===val('#el')&&l.pid===T.pid);if(!list)return toast('Choose a to-do list first');col_('todos').doc(id).update({title:t,listId:list.id,list:list.title,due:$('#edd').value,to})")
R("if(tool==='todos'){h+=`", "if(tool==='todos'){const ls=D.todolists.filter(l=>l.pid===pid);h+=`")
R(";const ls=D.todolists.filter(l=>l.pid===pid);\n   h+=ls.map(l=>`", ";\n   h+=ls.map(l=>`")
R('<button data-act="settings">⚙</button>', '<button data-act="settings">⚙</button><button data-act="logout" title="Log out">⏻</button>')
R('function sweep(){if(swept||!mgr||', 'function sweep(){if(true||swept||!mgr||')   # reminders now run on the server
R('<script>\nconst E=s=>', '<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#1d6b48"><script src="/shim.js"></script><script src="/auth.js"></script>\n<script>\nconst E=s=>')
open(os.path.join(root, 'public/index.html'), 'w', encoding='utf-8').write(s)
print('public/index.html written', len(s), 'bytes')
