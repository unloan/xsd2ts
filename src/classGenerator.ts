/**
 * Created by Eddy Spreeuwers at 11 march 2018
 */
import {
  ClassDefinition,
  ClassPropertyDefinition,
  createFile,
  EnumDefinition,
  FileDefinition,
  TypeDefinition,
} from "ts-code-generator";
import { DOMParser } from "xmldom-reborn";
import { ASTNode, getFieldType, NEWLINE } from "./parsing";
import { capFirst, log } from "./xml-utils";
import { regexpPattern2typeAlias, A2Z } from "./regexp2aliasType";
import { XsdGrammar } from "./xsd-grammar";

let XMLNS = "xmlns";
let definedTypes: string[];

const GROUP_PREFIX = "group_";
const XSD_NS = "http://www.w3.org/2001/XMLSchema";
const CLASS_PREFIX = ".";

const defaultSchemaName = "Schema";

const groups: { [key: string]: ASTNode } = {};
const ns2modMap = {} as Map<string, string>;

const primitive = /(string|number)/i;

const namespaces = { default: "", xsd: "xs" };
let targetNamespace = "s1";

function a2z(p: string) {
  return p.toLowerCase() == p ? A2Z.toLowerCase() : A2Z;
}
function capfirst(s: string = "") {
  return s[0]?.toUpperCase() + s?.substring(1);
}

function lowfirst(s: string = "") {
  return s[0]?.toLowerCase() + s?.substring(1);
}

function choiceBody(m: any, names: string[]): string {
  const name = m.attr.ref || m.attr.fieldName;
  const result = names
    .filter((n) => n !== name)
    .map((n) => `delete((this as any).${n});`)
    .join("\n");
  return result + `\n(this as any).${name} = arg;\n`;
}

function addNewImport(fileDef: FileDefinition, ns: string) {
  if (fileDef.imports.filter((i) => i.starImportName === ns).length === 0) {
    const modulePath = ns2modMap[ns];
    if (modulePath) {
      log("addNewImport: ", ns, modulePath);
      fileDef.addImport({ moduleSpecifier: modulePath, starImportName: ns });
    }
  }
}
function addClassForASTNode(
  fileDef: FileDefinition,
  astNode: ASTNode,
  indent = ""
): ClassDefinition {
  const c = fileDef.addClass({ name: capfirst(astNode.name) });

  if (astNode.nodeType === "Group") {
    c.isAbstract = true;
    // astNode.fields = astNode.list || [];
  }
  if (astNode.attr?.base) {
    let superClass = "";
    let [ns, qname] = astNode.attr.base.split(":");
    if (ns === targetNamespace) {
      superClass = capfirst(qname);
    } else if (qname) {
      superClass = ns.toLowerCase() + "." + capfirst(qname);
    } else {
      superClass = capfirst(ns);
    }
    c.addExtends(superClass);
  }

  log(
    indent + "created: ",
    astNode.name,
    ", fields: ",
    astNode?.children?.length
  );

  let fields = (astNode.children || []).filter((f) => f);
  fields
    .filter((f) => f.nodeType === "Fields")
    .forEach((f) => {
      log(indent + "adding named fields:", f.name);
      let superClass = "";
      if (f.attr.ref.indexOf(":") >= 0) {
        const [ns, qname] = f.attr.ref.split(":");
        log(indent + "split ns, qname: ", ns, qname);
        if (ns === targetNamespace) {
          superClass = capfirst(qname);
        } else {
          superClass = ns.toLowerCase() + "." + capfirst(qname);
          addNewImport(fileDef, ns);
        }
      } else {
        superClass = capfirst(f.attr.ref);
      }
      c.addExtends(superClass);
    });
  fields
    .filter((f) => f.nodeType === "Reference")
    .forEach((f) => {
      log(indent + "adding fields for Reference: ", f.attr.ref);

      const typePostFix = f.attr.array ? "[]" : "";
      const namePostFix = f.attr.array ? "?" : "";
      const [ns, localName] = /:/.test(f.attr.ref)
        ? f.attr.ref?.split(":")
        : [null, f.attr.ref];
      const refName = localName + namePostFix;
      let refType = "";
      if (ns === targetNamespace) {
        refType = capfirst(localName + typePostFix);
      } else {
        refType = (ns ? ns + "." : "") + capfirst(localName + typePostFix);
      }
      //rewrite the classes for single array field to direct type
      const classType = fileDef.getClass(refType);
      // if (classType && classType.properties.length === 1 && classType.properties[0].type.text.indexOf('[]') > 0 ){
      //     refType = classType.properties[0].type.text;
      //     fileDef.classes = fileDef.classes.filter ( c => c !== classType);
      //     log(indent + 'rewrite refType', refType);
      // } else {
      //     log(indent + 'no class for  refType', refType);
      // }
      c.addProperty({ name: refName, type: refType, scope: "protected" });
    });
  fields
    .filter((f) => f.nodeType === "choice")
    .forEach((f) => {
      const names = f.children?.map((i) => i.attr.fieldName || i.attr.ref);
      log(indent + "adding methods for choice", names.join(","));
      f.children?.forEach((m) => {
        const methodName = m.attr.fieldName || m.attr.ref;

        const method = c.addMethod({
          name: methodName,
          returnType: "void",
          scope: "protected",
        });
        console.log({ attr: m.attr });
        method.addParameter({
          name: "arg",
          // For redundant class, this should return the existing class instead of a new ref.
          type: m.attr.fieldType || capfirst(m.attr.ref),
        });
        method.onWriteFunctionBody = (w) => {
          w.write(choiceBody(m, names));
        };
        method.onBeforeWrite = (w) => w.write("//choice\n");
        // log('create class for:' ,m.ref, groups);
      });
      log(indent + "added methods", c.methods.map((m) => m.name).join(","));
    });
  fields
    .filter((f) => f.nodeType === "Field")
    .forEach((f) => {
      log(indent + "adding field:", {
        name: f.attr.fieldName,
        type: f.attr.fieldType,
      });

      let xmlns = "";
      let fldType = f.attr.fieldType;
      const typeParts = f.attr.fieldType.split(".");
      if (typeParts.length === 2) {
        xmlns = typeParts[0];
        fldType = typeParts[1];
        if (xmlns !== targetNamespace) {
          addNewImport(fileDef, xmlns);
        }
      }

      // whenever the default namespace (xmlns) is defined and not the xsd namespace
      // the types without namespace must be imported and thus prefixed with a ts namespace
      //
      const undefinedType = definedTypes.indexOf(fldType) < 0;
      log("defined: ", fldType, undefinedType);

      if (
        undefinedType &&
        namespaces.default &&
        namespaces.default !== XSD_NS &&
        "xmlns" !== targetNamespace
      ) {
        fldType = getFieldType(
          f.attr.type,
          "xmlns" !== targetNamespace ? XMLNS : null
        );
      }

      //rewrite the classes for single array field to direct type
      const classType = fileDef.getClass(fldType);
      // if (classType && classType.properties.length === 1 && classType.properties[0].type.text.indexOf('[]') > 0 ){
      //     fldType = classType.properties[0].type.text;
      //     fileDef.classes = fileDef.classes.filter ( c => c !== classType);
      //     log(indent + 'rewrite fldType', fldType);
      // }
      c.addProperty({
        name: f.attr.fieldName,
        type: fldType,
        scope: "protected",
      });

      log(
        indent + "nested class",
        f.attr.fieldName,
        JSON.stringify(f.attr.nestedClass)
      );
      if (f.attr.nestedClass) {
        addClassForASTNode(fileDef, f.attr.nestedClass, indent + " ");
      }
    });
  return c;
}

export class ClassGenerator {
  public types: string[] = [];
  public schemaName = "schema";
  public xmlnsName = "xmlns";
  private fileDef = createFile({ classes: [] });
  private verbose = false;
  private pluralPostFix = "s";
  private dependencies: Map<string, string>;
  private importMap: string[] = [];
  private targetNamespace = "s1";

  constructor(
    depMap?: Map<string, string>,
    private classPrefix = CLASS_PREFIX
  ) {
    this.dependencies = depMap || ({} as Map<string, string>);
    (Object as any).assign(ns2modMap, depMap);
    log(JSON.stringify(this.dependencies));
  }

  public generateClassFileDefinition(
    xsd: string,
    pluralPostFix = "s",
    verbose?: boolean
  ): FileDefinition {
    const fileDef = createFile();

    this.verbose = verbose;
    this.pluralPostFix = pluralPostFix;

    this.log(
      "--------------------generating classFile definition for----------------------------------"
    );
    this.log("");
    this.log(xsd);
    this.log("");
    this.log(
      "-------------------------------------------------------------------------------------"
    );

    if (!xsd) {
      return fileDef;
    }

    const ast = this.parseXsd(xsd);

    if (!ast) {
      return fileDef;
    }

    XMLNS = this.xmlnsName;

    const xsdNsAttr = Object.keys(ast.attr || [])
      .filter((n) => ast.attr[n] === XSD_NS)
      .shift();
    const xsdNs = xsdNsAttr.replace(/^\w+:/, "");
    const defNs = ast.attr.xmlns;
    targetNamespace = Object.keys(ast.attr || [])
      .filter(
        (n) =>
          ast.attr[n] === ast.attr.targetNamespace && n != "targetNamespace"
      )
      .shift();
    targetNamespace = targetNamespace?.replace(/^\w+:/, "");

    log("xsd namespace:", xsdNs);
    log("def namespace:", defNs);
    log("xsd targetnamespace:", targetNamespace);
    const typeAliases = {};

    //store namespaces
    namespaces.xsd = xsdNs;
    namespaces.default = defNs;

    if (defNs && defNs !== XSD_NS) addNewImport(fileDef, XMLNS);

    Object.keys(groups).forEach((key) => delete groups[key]);
    log("AST:\n", JSON.stringify(ast, null, 3));

    // create schema class

    const schemaClass = createFile().addClass({
      name: capfirst(ast?.name || defaultSchemaName),
    });

    const children = ast?.children || [];
    definedTypes = children.map((c) => c.name);
    log("definedTypes: ", JSON.stringify(definedTypes));

    children
      .filter((t) => t.nodeType === "AliasType")
      .forEach((t) => {
        let aliasType = getFieldType(t.attr.type, null);
        log(
          "alias type: ",
          t.name,
          ": ",
          t.attr.type,
          "->",
          aliasType,
          "\tattribs:",
          t.attr
        );
        if (t.attr.pattern) {
          //try to translate regexp pattern to type aliases as far as possible
          aliasType = regexpPattern2typeAlias(
            t.attr.pattern,
            aliasType,
            t.attr
          );
        }

        if (t.attr.minInclusive && t.attr.maxInclusive) {
          const x1 = parseInt(t.attr.minInclusive);
          const x2 = parseInt(t.attr.maxInclusive);
          const nrs = [];
          if (x2 - x1 < 100) {
            for (let n = x1; n <= x2; n++) {
              nrs.push(n);
            }
            aliasType = nrs.join("|");
          }
        }

        const [ns, localName] = aliasType.split(".");

        if (targetNamespace === ns && t.name === localName) {
          log("skipping alias:", aliasType);
        } else {
          if (ns === targetNamespace) {
            aliasType = capfirst(localName);
          }
          //skip circular refs
          log(
            "circular refs:",
            aliasType,
            t.name.toLowerCase() === aliasType.toLowerCase()
          );
          if (t.name.toLowerCase() !== aliasType.toLowerCase()) {
            if (primitive.test(aliasType)) {
              aliasType = aliasType.toLowerCase();
            }
            //fileDef.addTypeAlias({name: capfirst(t.name), type: aliasType, isExported: true});
            typeAliases[capfirst(t.name)] = aliasType;
            //only add elements to scheme class
          }
        }
        if (t.attr.element) {
          schemaClass.addProperty({
            name: lowfirst(t.name),
            type: capfirst(t.name),
          });
        }
      });

    fileDef.classes.push(schemaClass);

    children
      .filter((t) => t.nodeType === "Group")
      .forEach((t) => {
        groups[t.name] = t;
        log("storing group:", t.name);
        addClassForASTNode(fileDef, t);
      });

    children
      .filter((t) => t.nodeType === "Class")
      .forEach((t) => {
        const c = addClassForASTNode(fileDef, t);
        if (t.attr.element) {
          //when the class represents an array and is element then
          //add the class as field to the schemas class and remove the classdef
          // if (c && c.properties.length === 1 && c.properties[0].type.text.indexOf('[]') > 0){
          //     schemaClass.addProperty({name: lowfirst(t.name), type: c.properties[0].type.text});
          //     fileDef.classes = fileDef.classes.filter(x => x !== c);
          //     log('rewrite for', t.name);
          // } else {
          schemaClass.addProperty({
            name: lowfirst(t.name),
            type: capfirst(t.name),
          });
          //log('no rewrite for', t.name);
          //}
        }
      });

    children
      .filter((t) => t.nodeType === "Enumeration")
      .forEach((t) => {
        const enumDef = fileDef.addEnum({ name: capFirst(t.name) });
        t.attr.values.forEach((m) => {
          enumDef.addMember({
            name: m.attr.value.replace("+", "_"),
            value: `"${m.attr.value}"` as any,
          });
        });
        if (t.attr.element) {
          schemaClass.addProperty({
            name: lowfirst(t.name),
            type: capfirst(t.name),
          });
        }
      });

    const tmp = this.makeSortedFileDefinition(fileDef.classes, fileDef);
    Object.keys(typeAliases).forEach((k) => {
      fileDef.addTypeAlias({ name: k, type: typeAliases[k], isExported: true });
    });

    fileDef.classes = tmp.classes;
    //const members = fileDef.getMembers();
    //members.forEach(m => fileDef.setOrderOfMember(1, m.));

    return fileDef;
  }

  // private nsResolver(ns: string): void {
  //     log('nsResolver', ns);
  //     this.importMap[ns] = this.dependencies[ns] || "ns";
  //     log('nsResolver', ns, this.importMap);
  // }

  private findAttrValue(node: HTMLElement, attrName: string): string {
    return node?.attributes?.getNamedItem(attrName)?.value;
  }

  private nodeName(node: HTMLElement): string {
    return this.findAttrValue(node, "name");
  }

  private findChildren(node: HTMLElement): HTMLElement[] {
    const result: HTMLElement[] = [];
    let child = node?.firstChild;
    while (child) {
      if (!/function Text/.test("" + child.constructor)) {
        result.push(child as HTMLElement);
      }
      child = child.nextSibling;
    }
    return result;
  }

  private findFirstChild(node: HTMLElement): HTMLElement {
    return this.findChildren(node)[0];
  }

  private parseXsd(xsd: string) {
    const xsdGrammar = new XsdGrammar(this.schemaName);
    const xmlDom = new DOMParser().parseFromString(xsd, "application/xml");
    const xmlNode = xmlDom?.documentElement;
    return xsdGrammar.parse(xmlNode);
  }

  private log(message?: any, ...optionalParams: any[]): void {
    if (this.verbose) {
      console.log.apply(console, [message].concat(optionalParams));
    }
  }

  private makeSortedFileDefinition(
    sortedClasses: ClassDefinition[],
    fileDef: FileDefinition
  ): FileDefinition {
    //  console.log('makeSortedFileDefinition ');
    const outFile = createFile({ classes: [] });

    //outFile.addImport({moduleSpecifier: "mod", starImportName: "nspce"});
    for (const ns in this.importMap) {
      log("addImport: ", ns, this.importMap[ns]);
      outFile.addImport({
        moduleSpecifier: this.importMap[ns],
        starImportName: ns,
      });
    }

    let depth = 0;
    let max_depth = 1;
    log("makeSortedFileDefinition, max_depth ", max_depth);
    let redundantArrayClasses: string[] = [];
    while (depth <= max_depth) {
      // console.log('depth ');
      sortedClasses.forEach((c) => {
        const hDepth = this.findHierachyDepth(c, fileDef);

        if (hDepth > max_depth) {
          max_depth = hDepth;
        }
        this.log("--DEPTH:", c.name + "\t" + hDepth);
        if (hDepth === depth) {
          if (c.name.indexOf(GROUP_PREFIX) === 0) {
            // return;
          }

          outFile.addClass({ name: c.name });

          const classDef = outFile.getClass(c.name);
          classDef.methods = c.methods;
          classDef.isExported = true;
          classDef.isAbstract = c.isAbstract;
          let classProperty = new ClassPropertyDefinition();
          classProperty.name = `["@class"]`;
          classProperty.isReadonly = true;
          let stringTypedef = new TypeDefinition();
          stringTypedef.text = "string";
          classProperty.type = stringTypedef;
          this.addProtectedPropToClass(classDef, classProperty);
          c.extendsTypes.forEach((t) => classDef.addExtends(t.text));
          c.getPropertiesAndConstructorParameters().forEach((prop) => {
            const ct = sortedClasses.filter(
              (cd) => cd.name === prop.type.text.replace("[]", "")
            )[0];
            if (
              ct &&
              ct.properties.length === 1 &&
              ct.properties[0].type.text.indexOf("[]") > 0
            ) {
              prop.type.text = ct.properties[0].type.text;
              log(
                "array construct detected:",
                ct.name,
                prop.name,
                ct.properties[0].type.text,
                prop.type.text
              );
              redundantArrayClasses.push(ct.name);
            } else {
              //log('nonarray construct detected:', prop.name,  prop.type.text, sortedClasses.map(c=>c.name));
            }
            //log('addProtectedPropToClass:',classDef.name, prop.name, prop.type.text);
            this.addProtectedPropToClass(classDef, prop);
          });
          this.makeConstructor(classDef, c, outFile);
        }
      });
      // console.log('depth:', depth);
      depth++;
    }
    log("ready");
    log("redundantArrayClasses", redundantArrayClasses);
    outFile.classes = outFile.classes.filter(
      // @assumption: Asset and OtherAsset are filtered out here, that's why we don't get the class back
      // That assumption is true, but we're not supposed to use redundant class,
      // e.g. for HomePhone element, it's a sequence of Phone, instead of making another class for HomePhone
      // we can just use array of Phone instead.
      (c) => redundantArrayClasses.indexOf(c.name) < 0
    );
    log(
      "Classes",
      outFile.classes.map((c) => c.name)
    );
    return outFile;
  }

  //provide default constructor code that helps constructing
  //an object hierarchy through recursion
  private makeConstructor(
    classDef: ClassDefinition,
    c,
    outFile: FileDefinition
  ) {
    const constructor = classDef.addMethod({ name: "constructor" });
    constructor.scope = "protected";
    constructor.addParameter({ name: "props", type: c.name });
    constructor.onWriteFunctionBody = (writer) => {
      if (c.extendsTypes.length) {
        //writer.write('//' + JSON.stringify(c.extendsTypes[0].text) + '\n');
        if (outFile.getClass(c.extendsTypes[0].text) !== null) {
          writer.write(`super(props);\n`);
        } else {
          writer.write(`super();\n`);
        }
      }

      //writer.write('(<any>Object).assign(this, <any> props);\n');
      //writer.write(`\nconsole.log("constructor:", props);`);
      writer.write(`this["@class"] = "${this.classPrefix}${c.name}";\n`);
      const codeLines = [];
      classDef.getPropertiesAndConstructorParameters().forEach((prop) => {
        /**
         * This is kinda hacky, we detect the ? in the property name to determine whether it's optional or not.
         * This is because prop.isOptional is always false even when the property is optional.
         */
        const isOptional = prop.name.indexOf("?") >= 0;
        const propName = prop.name.replace("?", "");
        if (propName === `["@class"]`) {
          // Skip @class property, already assigned.
          return;
        }
        if (propName === "Asset" || propName === "OtherAsset") {
          console.log({
            label: "makeConstructor()",
            prop,
            propName,
            class: outFile.getClass(prop.type.text),
          });
        }
        if (outFile.getClass(prop.type.text) != null) {
          codeLines.push(
            isOptional
              ? `\tthis.${propName} = (props.${propName}) ? new ${prop.type.text}(props.${propName}): undefined;`
              : `\tthis.${propName} = new ${prop.type.text}(props.${propName});`
          );
        } else if (prop.type.text.indexOf("[]") >= 0) {
          const arrayType = prop.type.text.replace("[]", "");
          const expr =
            outFile.getClass(arrayType) != null ? `new ${arrayType}(o)` : "o";
          codeLines.push(
            `\tthis.${propName} = props.${propName}?.map(o => ${expr});`
          );
        } else {
          codeLines.push(`\tthis.${propName} = props.${propName};`);
        }
      });
      if (codeLines.length > 0) {
        writer.write(codeLines.join("\n"));
      }
    };
  }

  private addProtectedPropToClass(classDef: ClassDefinition, prop) {
    const type = prop.type.text;

    if (/^group_/.test(type)) {
      const c = this.fileDef.getClass(type);
      if (c) {
        c.getPropertiesAndConstructorParameters().forEach((p) => {
          this.addProtectedPropToClass(classDef, p);
        });
        return;
      }
    }

    //log('add property:', prop.name, prop.type.text);
    classDef.addProperty({
      defaultExpression: prop.defaultExpression
        ? prop.defaultExpression.text
        : null,
      name: prop.name,
      scope: "protected",
      type: prop.type.text,
    });
  }

  private findHierachyDepth(c: ClassDefinition, f: FileDefinition) {
    let result = 0;
    let superClassName = c.extendsTypes[0] ? c.extendsTypes[0].text : "";
    while (superClassName) {
      //console.log('superClassName1:', superClassName , result);
      result++;
      c = f.getClass(superClassName);
      superClassName = c?.extendsTypes[0]?.text;
      //console.log('superClassName2:', superClassName , c, result);
    }
    return result;
  }
}
