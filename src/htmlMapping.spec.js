import getRootOriginAtChar from "./getRootOriginAtChar"
import whereDoesCharComeFrom from "./whereDoesCharComeFrom"

import {disableProcessHTMLOnInitialLoad} from "./tracing/processElementsAvailableOnInitialLoad"
disableProcessHTMLOnInitialLoad()

describe("HTML Mapping", function(){
    beforeEach(function(){
        enableNativeMethodPatching()
    })
    afterEach(function(){
        disableNativeMethodPatching()
    })

    it("Traces a basic string assignment", function(){
        var el = document.createElement("div")
        el.innerHTML = "Hello"

        // <[d]iv>Hello</div>
        expect(getRootOriginAtChar(el, 1).origin.action).toBe("createElement")

        // <div>[H]ello</div>
        var firstStep = getRootOriginAtChar(el, 5);
        expect(firstStep.origin.action).toBe("Assign InnerHTML")
        expect(firstStep.origin.value[firstStep.characterIndex]).toBe("H")
    })

    it("Traces nested HTML assignments", function(){
        var el = document.createElement("div")
        el.innerHTML = 'Hello <b>World</b>!'
        var bTag = el.children[0]

        // <b>[W]orld</b>
        var firstStep = getRootOriginAtChar(bTag, 3);
        expect(firstStep.origin.action).toBe("Assign InnerHTML")
        expect(firstStep.origin.value[firstStep.characterIndex]).toBe("W")
    })

    it("Traces attributes without a value correctly", function(done){
        var el = document.createElement("div")
        el.innerHTML = '<span hello world>Hi</span>'
        var span = el.children[0]

        disableNativeMethodPatching()
        // just to clarify what's going on, Chrome is adding the "" to the attribute
        expect(el.innerHTML).toBe('<span hello="" world="">Hi</span>')

        // <span hello="" world="">[H]i</span>
        var firstStep = getRootOriginAtChar(span, 24);
        expect(firstStep.origin.action).toBe("Assign InnerHTML")
        expect(firstStep.origin.value[firstStep.characterIndex]).toBe("H")

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            // correctly traces back to assigned string
            expect(value).toBe("<span hello world>Hi</span>")
            expect(value[characterIndex]).toBe("H")
            done()
        })
    })

    it("Traces attributes with an empty value correctly", function(done){
        var el = document.createElement("div")
        el.innerHTML = '<span hello="">Hi</span>'
        var span = el.children[0]

        disableNativeMethodPatching()

        // <span hello="">[H]i</span>
        var firstStep = getRootOriginAtChar(span, 15);
        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            // correctly traces back to assigned string
            expect(value).toBe("<span hello=\"\">Hi</span>")
            expect(value[characterIndex]).toBe("H")
            done()
        })
    })

    it("Traces attribute values that contain an escaped &amp; HTML entity correctly", function(done){
        var el = document.createElement("div")
        el.innerHTML = '<span hi="&amp;test"></span>'
        var span = el.children[0]

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('<span hi="&amp;test"></span>')

        // <span hi="&amp;test"></span>
        var firstStep = getRootOriginAtChar(span, 15);
        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            // correctly traces back to assigned string
            expect(value).toBe('<span hi="&amp;test"></span>')
            expect(value[characterIndex]).toBe("t")
            done()
        })
    })

    it("Traces attribute values that contain an unescaped ^ character correctly", function(done){
        var el = document.createElement("div")
        el.innerHTML = '<span hi="&test"></span>'
        var span = el.children[0]

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('<span hi="&amp;test"></span>')

        // <span hi="&amp;test"></span>
        var firstStep = getRootOriginAtChar(span, 15);
        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            // correctly traces back to assigned string
            expect(value).toBe('<span hi="&test"></span>')
            expect(value[characterIndex]).toBe("t")
            done()
        })
    })

    it("Traces attribute values that contain an escaped &raquo; character correctly", function(done){
        var el = document.createElement("div")
        el.innerHTML = '<span hi="&raquo;test"></span>'
        var span = el.children[0]

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('<span hi="»test"></span>')

        // <span hi="»test"></span>
        var firstStep = getRootOriginAtChar(span, 11);
        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            // correctly traces back to assigned string
            expect(value).toBe('<span hi="&raquo;test"></span>')
            expect(value[characterIndex]).toBe("t")
            done()
        })
    })

    it("Traces attribute values that contain an HTML entity that uses the number sign", function(done){
        var el = document.createElement("div")
        el.innerHTML = '<span hi="&#39;world"></span>'
        var span = el.children[0]

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('<span hi="\'world"></span>')

        // <span hi="\'worl[d]"></span>
        var firstStep = getRootOriginAtChar(span, 15);
        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            // correctly traces back to assigned string
            expect(value).toBe('<span hi="&#39;world"></span>')
            expect(value[characterIndex]).toBe("d")
            done()
        })
    })

    it("Traces an extra space at the end of a tag correctly", function(done){
        var el = document.createElement("div")
        el.innerHTML = '<span >Hi</span>'
        var span = el.children[0]

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('<span>Hi</span>')

        // <span>[H]i</span>
        var firstStep = getRootOriginAtChar(span, 6);

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value).toBe("<span >Hi</span>")
            expect(value[characterIndex]).toBe("H")
            done()
        })
    })

    it("Traces an extra space at the end of a self-closing tag correctly", function(done){
        var el = document.createElement("div")
        el.innerHTML = '<span><input \n/>Hey</span>'
        var span = el.children[0]

        disableNativeMethodPatching()
        expect(span.innerHTML).toBe('<input>Hey')

        // <span><input>[H]ey</span>
        var firstStep = getRootOriginAtChar(span, 13);

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value).toBe("<span><input \n/>Hey</span>")
            expect(value[characterIndex]).toBe("H")
            done()
        })
    })

    it("Traces extra whitespace at the end of a tag correctly", function(done){
        var el = document.createElement("div")
        el.innerHTML = '<span \n\n\t>Hi</span>'
        var span = el.children[0]

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('<span>Hi</span>')

        // <span>[H]i</span>
        var firstStep = getRootOriginAtChar(span, 6);

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value).toBe("<span \n\n\t>Hi</span>")
            expect(value[characterIndex]).toBe("H")
            done()
        })
    })

    it("Traces attributes correctly", function(done){
        var el = document.createElement("div")
        el.innerHTML = '<span hi="hey" cake="cookie"></span>'

        var span = el.children[0]

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('<span hi="hey" cake="cookie"></span>')

        // <span hi="hey" ca[k]e="cookie"></span>
        var firstStep = getRootOriginAtChar(span, 17);

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value).toBe('<span hi="hey" cake="cookie"></span>')
            expect(value[characterIndex]).toBe("k")
            done()
        })
    })

    it("Traces extra spaces between attributes correctly", function(done){
        var el = document.createElement("div")
        el.innerHTML = '<span hi="hey"       \ncake="cookie"></span>'

        var span = el.children[0]

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('<span hi="hey" cake="cookie"></span>')

        // <span hi="hey" ca[k]e="cookie"></span>
        var firstStep = getRootOriginAtChar(span, 17);

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value).toBe('<span hi="hey"       \ncake="cookie"></span>')
            expect(value[characterIndex]).toBe("k")
            done()
        })
    })

    it("Traces unescaped HTML &/</> correctly", function(done){
        var el = document.createElement("div")
        el.innerHTML = '&'

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('&amp;')

        // <div>&a[m]p;</div>
        var firstStep = getRootOriginAtChar(el, 7);

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value).toBe("&")
            expect(characterIndex).toBe(0)
            done()
        })
    })

    it("Traces unescaped HTML entities correctly", function(done){
        var el = document.createElement("div")
        el.innerHTML = '»'

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('»')

        // <div>»</div>
        var firstStep = getRootOriginAtChar(el, 5);

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value).toBe("»")
            expect(characterIndex).toBe(0)
            done()
        })
    })

    it("Traces escaped HTML entities correctly", function(done){
        var el = document.createElement("div")
        el.innerHTML = 'sth&raquo;'

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('sth»')

        // <div>sth[»]</div>
        var firstStep = getRootOriginAtChar(el, 8);

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value).toBe("sth&raquo;")
            expect(characterIndex).toBe(3)
            done()
        })
    })

    it("Doesn't get confused by comments", function(done){
        var el = document.createElement("div")
        el.innerHTML = 'ab<!-- hi -->cd'

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('ab<!-- hi -->cd')

        // <div>ab<!-- hi -->[c]d</div>
        var firstStep = getRootOriginAtChar(el, 18);

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value).toBe("ab<!-- hi -->cd")
            expect(value[characterIndex]).toBe("c")
            done()
        })
    })

    it("Keeps track of comments", function(){
        var div = document.createElement("div")
        var str = "Hi <!-- World -->"
        div.innerHTML = str

        expect(div.childNodes[1].__elOrigin.commentStart.action).toBe("Assign InnerHTML")
        expect(div.childNodes[1].__elOrigin.textValue.value).toBe(str)
    })

    it("Doesn't get confused by closed self-closing tags", function(done){
        var el = document.createElement("div")
        el.innerHTML = '<input/>Hello'

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('<input>Hello')

        // <div><input>H[e]llo</div>
        var firstStep = getRootOriginAtChar(el, 13);

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value).toBe("<input/>Hello")
            expect(value[characterIndex]).toBe("e")
            done()
        })
    })

    it("Can handle HTML entities inside NOSCRIPT tags", function(){
        var el = document.createElement("noscript")
        el.innerHTML = '&gt;abc&#x3D;'

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('&amp;gt;abc&amp;#x3D;')

        // <noscript>&amp;[g]t;abc&amp;#x3D;</noscript>
        var firstStep = getRootOriginAtChar(el, 15);

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value[characterIndex]).toBe("g")
        })

        firstStep = getRootOriginAtChar(el, 26);

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value[characterIndex]).toBe("#")
        })
    })

    it("Doesn't get confused by closed self-closing tags with an explicit end tag", function(done){
        var el = document.createElement("div")
        el.innerHTML = '<input></input>Hello'

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('<input>Hello')

        // <div><input>H[e]llo</div>
        var firstStep = getRootOriginAtChar(el, 13);

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value).toBe("<input></input>Hello")
            expect(value[characterIndex]).toBe("e")
            done()
        })
    })

    it("Correctly maps text containing a CRLF line break (rather than just LF)", function(done){
        var el = document.createElement("div")
        el.innerHTML = '<span>ab\r\ncd</span>'
        var span = el.children[0]

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('<span>ab\ncd</span>')

        // <span>ab\ncd</span>
        var firstStep = getRootOriginAtChar(span, 9);

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value).toBe('<span>ab\r\ncd</span>')
            expect(value[characterIndex]).toBe("c")
            done()
        })
    })

    it("Correctly maps tags containing a CRLF line break (rather than just LF)", function(done){
        var el = document.createElement("div")
        el.innerHTML = '<span\r\n hi="ho"\r\n>abc</span>'
        var span = el.children[0]

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('<span hi="ho">abc</span>')

        // <span hi="ho">abc</span>
        var firstStep = getRootOriginAtChar(span, 14);

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value).toBe('<span\r\n hi="ho"\r\n>abc</span>')
            expect(value[characterIndex]).toBe("a")
            done()
        })
    })

    it("Correctly maps attributes containing a CRLF line break (rather than just LF)", function(done){
        var el = document.createElement("div")
        el.innerHTML = '<span hi="\r\nhey"></span>'
        var span = el.children[0]

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('<span hi="\nhey"></span>')

        // <span hi="\nhey"></span>
        var firstStep = getRootOriginAtChar(span, 11);

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value).toBe('<span hi="\r\nhey"></span>')
            expect(value[characterIndex]).toBe("h")
            done()
        })
    })

    it("Supports insertAdjacentHTML with position 'afterBegin'", function(done){
        var el = document.createElement("div");
        el.innerHTML = " World";
        el.insertAdjacentHTML("afterBegin", "Hello")

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('Hello World')

        // <div>Hello [W]orld</div>
        var firstStep = getRootOriginAtChar(el, 11)

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value).toBe(' World')
            expect(value[characterIndex]).toBe("W")
            done()
        })
    })


    it("Supports attributes that have spaces between the attr name and the value", function(done){
        var el = document.createElement("div");
        el.innerHTML = '<span a  \t\n =\n   "b">Hello</span>';

        disableNativeMethodPatching()
        expect(el.innerHTML).toBe('<span a="b">Hello</span>')

        // <div><span a="b">[H]ello</span></div>
        var firstStep = getRootOriginAtChar(el, 17)

        whereDoesCharComeFrom(firstStep, function(steps){
            var value = steps[1].origin.value;
            var characterIndex = steps[1].characterIndex
            expect(value[characterIndex]).toBe("H")
            done()
        })
    })
})
