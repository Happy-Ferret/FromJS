import processJSCode from "./processJavaScriptCode"
import babelPlugin from "./plugin"

var processJavaScriptCode = processJSCode(babelPlugin)

describe("processJavaScriptCode", function(){
    it("Wraps string literals with an object with an origin", function(){
        var code = "var a = 'Hello';a"
        code = processJavaScriptCode(code).code
        expect(eval(code).origin.action).toBe("String Literal")
    })

    it("Doesn't break conditional operator when used with a tracked string", function(){
        var code = "'' ? true : false"
        code = processJavaScriptCode(code).code
        expect(eval(code)).toBe(false)
    })

    it("Doesn't break if statements when used with a tracked string", function(){
        var code = `
            var a = false
            if ("") {
                a = true
            };
            a
        `
        code = processJavaScriptCode(code).code
        expect(eval(code)).toBe(false)
    })

    it("Doesn't break when encountering an accessor in an object literal", function(){
        var code = `
        var val = null;
        var obj = {
            set val(newVal) {val = newVal + "!"},
            get val(){return val}
        }
        obj.val = "Hi"
        obj.val
        `
        code = processJavaScriptCode(code).code
        expect(eval(code).value).toBe("Hi!")
    })

    it("Supports for loop conditions that return a string", function(){
        var code = `
            var wasInBody = false;
            for (var a=0; "";) {
                wasInBody = true;
                break;
            }
            wasInBody;
        `
        code = processJavaScriptCode(code).code;
        expect(eval(code)).toBe(false)
    })

    it("Supports for loops that don't have a condition", function(){
        var code = `
            var wasInBody = false;
            for (var a=0;;) {
                wasInBody = true;
                break;
            }
            wasInBody;
        `
        code = processJavaScriptCode(code).code;
        expect(eval(code)).toBe(true)
    })

    it("Supports while loop conditions that return a string", function(){
        var code = `
            var wasInBody = false;
            while ("") {
                wasInBody = true;
                break;
            }
            wasInBody;
        `
        code = processJavaScriptCode(code).code;
        expect(eval(code)).toBe(false)
    })

    it("Replaces division with f__divide", function(){
        var code = "1/2";
        code = processJavaScriptCode(code).code
        expect(code).toBe("f__divide(1, 2);")
    })

    it("Replaces multiplication with f__multiply", function(){
        var code = "1*2";
        code = processJavaScriptCode(code).code
        expect(code).toBe("f__multiply(1, 2);")
    })

    it("Replaces subtraction with f__subtract", function(){
        var code = "1-2";
        code = processJavaScriptCode(code).code
        expect(code).toBe("f__subtract(1, 2);")
    })

    it("Doesn't break normal OR expressions", function(){
        var code = "var a = {} || false;a"
        code = processJavaScriptCode(code).code
        expect(eval(code)).toEqual({})
    })

    it("Can handle chained AND expressions", function(){
        var code = `true && false && true && true`
        code = processJavaScriptCode(code).code
        expect(eval(code)).toBe(false)
    })

    it("Can handle chained OR expressions", function(){
        var code = `false || false || true || true`
        code = processJavaScriptCode(code).code
        expect(eval(code)).toBe(true)
    })

    it("Can handle parenthesis and OR/AND expressions", function(){
        var code = `false && true && (false || true)`
        code = processJavaScriptCode(code).code
        expect(eval(code)).toBe(false)
    })

    it("Returns the correct value from OR expressions on tracked strings", function(){
        var code = "'' || 'hi'"
        code = processJavaScriptCode(code).code
        expect(eval(code).value).toBe("hi")
    })

    it("Returns the correct value from AND expressions on tracked strings", function(){
        var code = "'hi' && ''"
        code = processJavaScriptCode(code).code
        expect(eval(code).value).toBe("")
    })

    it("Doesn't try to evaluate the second part of an AND expression if the first part is falsy", function(){
        var code = "var obj = undefined;obj && obj.hi"
        code = processJavaScriptCode(code).code
        expect(eval(code)).toBe(undefined)
    })

    it("Converts value to boolean when using NOT operator", function(){
        var code = "!''"
        code = processJavaScriptCode(code).code
        expect(eval(code)).toBe(true)

        code = "!!''"
        code = processJavaScriptCode(code).code
        expect(eval(code)).toBe(false)
    })

    it("Works correctly when nesting AND and OR expressions", function(){
        // I used to have suspicions that the cached value could break something like this,
        // but it seems to work.
        var code = "(1 && 2) || 3"

        code = processJavaScriptCode(code).code
        expect(eval(code)).toBe(2)
    })

    it("f__assign returns the assigned value", function(){
        var obj = {};
        var res = f__assign(obj, "prop", "value")
        expect(res).toBe("value")
    })

    it("Replaces .readyState lookups with f__getReadyState calls", function(){
        window.f__getReadyState = function(){}
        spyOn(window, "f__getReadyState").and.returnValue("abc");
        var code = `
            document.readyState;
            document["readyState"];
            ({})["readyState"];
            document.readyState.indexOf("complete")
            window.document.readyState;
        `
        code = processJavaScriptCode(code).code;
        eval(code);

        expect(window.f__getReadyState).toHaveBeenCalledTimes(5)
    })

    it("Replaces .toString lookups with f__getToString calls", function(){
        spyOn(window, "f__getToString").and.callThrough()
        var code = `
            var str = "Hello";
            str = str.toString();
            str
        `

        code = processJavaScriptCode(code).code;
        var res = eval(code);

        expect(window.f__getToString).toHaveBeenCalled();
        expect(res.value).not.toBe(undefined)
    })

    describe("For..in loops", function(){
        it("Gives access to the tracked property names in a for...in loop", function(){
            var code = `
                var obj = {"hi": "there"};
                var key;
                for (key in obj){};
                key;
            `
            code = processJavaScriptCode(code).code;
            var evalRes = eval(code)
            expect(evalRes.value).toBe("hi")
            expect(evalRes.origin.action).toBe("String Literal")
        });

        it("For...in loops work without a block statement body", function(){
            var code = `
                var obj = {"hi": "there"};
                var key;
                for (key in obj) false ? "cake": "cookie";
                key;
            `
            code = processJavaScriptCode(code).code;
            var evalRes = eval(code)
            expect(evalRes.value).toBe("hi")
            expect(evalRes.origin.action).toBe("String Literal")
        });

        it("For...in loops work when accessing a property name from a member expression", function(){
            var code = `
                var obj = {
                    sth: {"hi": "there"}
                }
                var key;
                for (key in obj.sth) if (false) {};
                key;
            `
            code = processJavaScriptCode(code).code;
            var evalRes = eval(code)
            expect(evalRes.value).toBe("hi")
            expect(evalRes.origin.action).toBe("String Literal")
        });

        it("For...in loops work when interating over a traced string", function(){
            var code = `
                var charIndices = [];
                for (var charIndex in "abc") {
                    charIndices.push(parseFloat(charIndex))
                }
                charIndices;
                `
            code = processJavaScriptCode(code).code;
            var evalRes = eval(code)
            expect(evalRes.length).toBe(3)
            expect(evalRes).toEqual([0, 1, 2])
        });
    })


    it("Can handle nested conditional operators", function(){
         var code = "var a = true ? ('' ? null : ({} ? 'yes' : null)) : null;a"
        code = processJavaScriptCode(code).code
        expect(eval(code).value).toBe("yes")
    })

    it("Supports != comparisons", function(){
        var code = `
            "a" != "a"
        `
        code = processJavaScriptCode(code).code
        expect(eval(code)).toBe(false)
    })

    it("Supports == comparisons", function(){
        var code = `
            "a" == "a"
        `
        code = processJavaScriptCode(code).code
        expect(eval(code)).toBe(true)
    })

    it("Replaces .pathname lookups with f__getPathname calls", function(){
        spyOn(window, "f__getPathname").and.returnValue({ value: "cake" })
        var code = `
            var str = location.pathname;
            str
        `

        code = processJavaScriptCode(code).code;
        var res = eval(code);

        expect(window.f__getPathname).toHaveBeenCalled();
        expect(res.value).toBe("cake")
    })

    it("Doesn't break for in statements that contain a for loop", function(){
        var code = `
            var obj = {a: [1,2,3]}
            var arr = []
            for (var key in obj) 
                for (var i=0; i< obj[key].length; i++)
                    arr.push(obj[key][i])
            arr
        `
        code = processJavaScriptCode(code).code
        var res = eval(code)
        expect(res).toEqual([1,2,3])
    })

    it("Always uses a real value for memberexpression property", function(){
        var code = `a[b]`
        code = processJavaScriptCode(code).code
        expect(code).toBe(`a[f__useValueAsPropertyKey(b)];`)
    })
})
