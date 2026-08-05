# Third-Party Notices

Remote VNC itself is licensed under the MIT License (see `LICENSE`).

The shipped bundles additionally contain code from the projects below. That code
remains under its own license; the terms here apply only to those portions, not
to Remote VNC as a whole.

---

## noVNC

Compiled into `media/webview.js`.

- Project: <https://github.com/novnc/noVNC>
- Portion bundled: the core library (`core/**/*.js`)
- Copyright (C) The noVNC authors — see <https://github.com/novnc/noVNC/blob/master/AUTHORS>
- License: **Mozilla Public License 2.0**

The full license text is at <https://mozilla.org/MPL/2.0/> and in the project's
`LICENSE.txt`.

**Source code availability.** The bundled form is minified. The corresponding
Source Code Form, as required by MPL 2.0 § 3.2, is the published `@novnc/novnc`
npm package at the version named in the banner comment at the top of
`media/webview.js`, available from:

- <https://www.npmjs.com/package/@novnc/novnc>
- <https://github.com/novnc/noVNC>

Remote VNC does not modify the noVNC sources. It adjusts one runtime behaviour
(the set of advertised RFB encodings) by wrapping a method after import, leaving
the covered files unchanged.

noVNC in turn incorporates the two components below, which the bundler pulls in
along with it. They are not under MPL 2.0 and carry their own notices.

### pako (bundled via noVNC `vendor/pako/`)

Provides the zlib implementation behind the Tight, Zlib and ZRLE decoders.
Project: <https://github.com/nodeca/pako>

```
(The MIT License)

Copyright (C) 2014-2016 by Vitaly Puzrin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### DES cipher (bundled via noVNC `core/crypto/des.js`)

Provides the DES implementation used by classic VNC password authentication.
Ported from the Flashlight VNC ActionScript implementation, itself extracted
from package Acme.Crypto. Its terms require that the copyright notice be kept
intact.

```
This DES class has been extracted from package Acme.Crypto for use in VNC.
The unnecessary odd parity code has been removed.

These changes are:
 Copyright (C) 1999 AT&T Laboratories Cambridge.  All Rights Reserved.

This software is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

DesCipher - the DES encryption method

The meat of this code is by Dave Zimmerman <dzimm@widget.com>, and is:

Copyright (c) 1996 Widget Workshop, Inc. All Rights Reserved.

Permission to use, copy, modify, and distribute this software
and its documentation for NON-COMMERCIAL or COMMERCIAL purposes and
without fee is hereby granted, provided that this copyright notice is kept
intact.

WIDGET WORKSHOP MAKES NO REPRESENTATIONS OR WARRANTIES ABOUT THE SUITABILITY
OF THE SOFTWARE, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE, OR NON-INFRINGEMENT. WIDGET WORKSHOP SHALL NOT BE LIABLE
FOR ANY DAMAGES SUFFERED BY LICENSEE AS A RESULT OF USING, MODIFYING OR
DISTRIBUTING THIS SOFTWARE OR ITS DERIVATIVES.

THIS SOFTWARE IS NOT DESIGNED OR INTENDED FOR USE OR RESALE AS ON-LINE
CONTROL EQUIPMENT IN HAZARDOUS ENVIRONMENTS REQUIRING FAIL-SAFE
PERFORMANCE, SUCH AS IN THE OPERATION OF NUCLEAR FACILITIES, AIRCRAFT
NAVIGATION OR COMMUNICATION SYSTEMS, AIR TRAFFIC CONTROL, DIRECT LIFE
SUPPORT MACHINES, OR WEAPONS SYSTEMS, IN WHICH THE FAILURE OF THE
SOFTWARE COULD LEAD DIRECTLY TO DEATH, PERSONAL INJURY, OR SEVERE
PHYSICAL OR ENVIRONMENTAL DAMAGE ("HIGH RISK ACTIVITIES").  WIDGET WORKSHOP
SPECIFICALLY DISCLAIMS ANY EXPRESS OR IMPLIED WARRANTY OF FITNESS FOR
HIGH RISK ACTIVITIES.
```

---

## ws

Compiled into `dist/extension.js`.

- Project: <https://github.com/websockets/ws>
- License: **MIT**

```
Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## gifenc

Compiled into `media/webview.js`.

- Project: <https://github.com/mattdesl/gifenc>
- Copyright (c) 2017 Matt DesLauriers
- License: **MIT**

```
The MIT License (MIT)
Copyright (c) 2017 Matt DesLauriers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
OR OTHER DEALINGS IN THE SOFTWARE.
```
