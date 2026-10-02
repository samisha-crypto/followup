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
R('<button data-act="settings">⚙</button>', '<button data-act="settings">⚙</button><button data-act="logout" title="Log out">⏻</button>')
R('function sweep(){if(swept||!mgr||', 'function sweep(){if(true||swept||!mgr||')   # reminders now run on the server
R('<script>\nconst E=s=>', '<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#1d6b48"><script src="/shim.js"></script><script src="/auth.js"></script>\n<script>\nconst E=s=>')
open(os.path.join(root, 'public/index.html'), 'w', encoding='utf-8').write(s)
print('public/index.html written', len(s), 'bytes')
