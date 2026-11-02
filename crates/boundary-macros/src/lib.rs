#![doc = "Optional derives for `boundary-core`."]
#![forbid(unsafe_code)]

use proc_macro::TokenStream;
use quote::quote;
use syn::{
    Data, DeriveInput, Error, Fields, LitStr, Token, Type, parse_macro_input,
    punctuated::Punctuated,
};

#[derive(Default)]
struct InteractionArgs {
    id: Option<LitStr>,
    output: Option<Type>,
    error: Option<Type>,
    error_codec: Option<Type>,
    reads: Vec<LitStr>,
    changes: Vec<LitStr>,
    no_input: bool,
}

fn parse_interaction_args(input: &DeriveInput) -> syn::Result<InteractionArgs> {
    let mut args = InteractionArgs::default();
    for attribute in input
        .attrs
        .iter()
        .filter(|attribute| attribute.path().is_ident("interaction"))
    {
        attribute.parse_nested_meta(|meta| {
            if meta.path.is_ident("id") {
                args.id = Some(meta.value()?.parse()?);
                return Ok(());
            }
            if meta.path.is_ident("output") {
                args.output = Some(meta.value()?.parse()?);
                return Ok(());
            }
            if meta.path.is_ident("error") {
                args.error = Some(meta.value()?.parse()?);
                return Ok(());
            }
            if meta.path.is_ident("error_codec") {
                args.error_codec = Some(meta.value()?.parse()?);
                return Ok(());
            }
            if meta.path.is_ident("reads") || meta.path.is_ident("changes") {
                let content;
                syn::parenthesized!(content in meta.input);
                let values = Punctuated::<LitStr, Token![,]>::parse_terminated(&content)?;
                if meta.path.is_ident("reads") {
                    args.reads.extend(values);
                } else {
                    args.changes.extend(values);
                }
                return Ok(());
            }
            if meta.path.is_ident("no_input") {
                args.no_input = true;
                return Ok(());
            }
            Err(meta.error("BOUNDARY_INTERACTION_ATTRIBUTE: unsupported interaction attribute"))
        })?;
    }
    Ok(args)
}

fn documentation(input: &DeriveInput) -> (LitStr, LitStr) {
    let mut lines = Vec::new();
    for attribute in input
        .attrs
        .iter()
        .filter(|attribute| attribute.path().is_ident("doc"))
    {
        if let syn::Meta::NameValue(name_value) = &attribute.meta
            && let syn::Expr::Lit(expression) = &name_value.value
            && let syn::Lit::Str(value) = &expression.lit
        {
            lines.push(value.value().trim().to_owned());
        }
    }
    let mut meaningful = lines.into_iter().filter(|line| !line.is_empty());
    let summary = meaningful.next().unwrap_or_default();
    let description = meaningful.collect::<Vec<_>>().join("\n");
    (
        LitStr::new(&summary, input.ident.span()),
        LitStr::new(&description, input.ident.span()),
    )
}

/// Derives `boundary_core::Interaction` from explicit `#[interaction(...)]` metadata.
#[proc_macro_derive(Interaction, attributes(interaction))]
pub fn derive_interaction(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    match expand_interaction(&input) {
        Ok(tokens) => tokens.into(),
        Err(error) => error.to_compile_error().into(),
    }
}

fn expand_interaction(input: &DeriveInput) -> syn::Result<proc_macro2::TokenStream> {
    let Data::Struct(data) = &input.data else {
        return Err(Error::new_spanned(
            input,
            "BOUNDARY_INTERACTION_SHAPE: Interaction can only be derived for a struct",
        ));
    };
    if matches!(data.fields, Fields::Unnamed(_)) {
        return Err(Error::new_spanned(
            &data.fields,
            "BOUNDARY_INTERACTION_SHAPE: tuple request structs are not supported",
        ));
    }
    let args = parse_interaction_args(input)?;
    let id = args.id.ok_or_else(|| {
        Error::new_spanned(
            &input.ident,
            "BOUNDARY_INTERACTION_ID: missing `id = \"...\"`",
        )
    })?;
    let output = args.output.ok_or_else(|| {
        Error::new_spanned(
            &input.ident,
            "BOUNDARY_INTERACTION_OUTPUT: missing `output = Type`",
        )
    })?;
    if args.no_input && !data.fields.is_empty() {
        return Err(Error::new_spanned(
            &data.fields,
            "BOUNDARY_INTERACTION_ARITY: `no_input` requires a fieldless struct",
        ));
    }

    let name = &input.ident;
    let (impl_generics, type_generics, where_clause) = input.generics.split_for_impl();
    let (summary, description) = documentation(input);
    let changes = args.changes;
    let reads = if args.reads.is_empty() && !changes.is_empty() {
        changes.clone()
    } else {
        args.reads
    };
    let arity = if args.no_input {
        quote!(::boundary_core::InputArity::Zero)
    } else {
        quote!(::boundary_core::InputArity::One)
    };
    let input_codec = if args.no_input {
        quote!(::boundary_core::EmptyObjectCodec<Self>)
    } else {
        quote!(::boundary_core::JsonCodec<Self>)
    };
    let (error_type, error_codec) = if let Some(error) = args.error {
        let codec = args.error_codec.map_or_else(
            || quote!(::boundary_core::JsonCodec<#error>),
            |codec| quote!(#codec),
        );
        (quote!(#error), codec)
    } else {
        if let Some(codec) = args.error_codec {
            return Err(syn::Error::new_spanned(
                codec,
                "BOUNDARY_INTERACTION_ERROR_CODEC: `error_codec` requires `error = Type`",
            ));
        }
        (
            quote!(::boundary_core::NoError),
            quote!(::boundary_core::NoError),
        )
    };
    let (effect, footprint) = if changes.is_empty() {
        (
            quote!(::boundary_core::ReadOnly),
            quote!(::boundary_core::ReadFootprint::new(&[#(#reads),*])),
        )
    } else {
        (
            quote!(::boundary_core::ChangesState),
            quote!(::boundary_core::ChangeFootprint::new(&[#(#reads),*], &[#(#changes),*])),
        )
    };

    Ok(quote! {
        impl #impl_generics ::boundary_core::Interaction for #name #type_generics #where_clause {
            const ID: ::boundary_core::StaticInteractionId = ::boundary_core::interaction_id!(#id);
            const INPUT_ARITY: ::boundary_core::InputArity = #arity;
            type Output = #output;
            type Error = #error_type;
            type Effect = #effect;
            type InputCodec = #input_codec;
            type OutputCodec = ::boundary_core::JsonCodec<Self::Output>;
            type ErrorCodec = #error_codec;

            fn footprint() -> <Self::Effect as ::boundary_core::EffectClass>::Footprint {
                #footprint
            }

            fn docs() -> ::boundary_core::InteractionDocs {
                ::boundary_core::InteractionDocs {
                    summary: #summary,
                    description: #description,
                }
            }
        }
    })
}

/// Derives a stable portable fault code for every enum variant.
///
/// Each variant must declare `#[fault(code = "domain.code")]`.
///
/// An enum marked `#[serde(tag = "code", content = "details")]` is the portable
/// `{ code, details }` error envelope itself. Each of its variants must be
/// serialized under its fault code, so name it `#[serde(rename = "domain.code")]`
/// (or make the variant identifier equal the code).
#[proc_macro_derive(Fault, attributes(fault))]
pub fn derive_fault(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    match expand_fault(&input) {
        Ok(tokens) => tokens.into(),
        Err(error) => error.to_compile_error().into(),
    }
}

fn expand_fault(input: &DeriveInput) -> syn::Result<proc_macro2::TokenStream> {
    let Data::Enum(data) = &input.data else {
        return Err(Error::new_spanned(
            input,
            "BOUNDARY_FAULT_SHAPE: Fault can only be derived for an enum",
        ));
    };
    let envelope = serde_container(input)?;
    let mut arms = Vec::new();
    for variant in &data.variants {
        let mut code = None;
        for attribute in variant
            .attrs
            .iter()
            .filter(|attribute| attribute.path().is_ident("fault"))
        {
            attribute.parse_nested_meta(|meta| {
                if meta.path.is_ident("code") {
                    code = Some(meta.value()?.parse::<LitStr>()?);
                    Ok(())
                } else {
                    Err(meta.error("BOUNDARY_FAULT_ATTRIBUTE: only `code` is supported"))
                }
            })?;
        }
        let code = code.ok_or_else(|| {
            Error::new_spanned(
                &variant.ident,
                "BOUNDARY_FAULT_CODE: every variant requires `#[fault(code = \"...\")]`",
            )
        })?;
        if code.value().is_empty() {
            return Err(Error::new_spanned(
                code,
                "BOUNDARY_FAULT_CODE: code must not be empty",
            ));
        }
        if envelope.is_envelope() {
            if !is_token(&code.value()) {
                return Err(Error::new_spanned(
                    &code,
                    "BOUNDARY_FAULT_CODE: with `tag = \"code\", content = \"details\"` the code must be \
                     an ASCII token matching `[A-Za-z][A-Za-z0-9_-]{0,63}`",
                ));
            }
            let serialized = serde_variant_name(variant)?
                .or_else(|| (!envelope.rename_all).then(|| variant.ident.to_string()));
            if serialized.as_deref() != Some(code.value().as_str()) {
                return Err(Error::new_spanned(
                    &variant.ident,
                    "BOUNDARY_FAULT_SERDE_CODE: with `tag = \"code\", content = \"details\"` the \
                     serde variant name must equal the fault code; add `#[serde(rename = \"<code>\")]`",
                ));
            }
        }
        let variant_name = &variant.ident;
        let pattern = match &variant.fields {
            Fields::Unit => quote!(Self::#variant_name),
            Fields::Unnamed(_) => quote!(Self::#variant_name(..)),
            Fields::Named(_) => quote!(Self::#variant_name { .. }),
        };
        arms.push(quote!(#pattern => #code));
    }
    let name = &input.ident;
    let is_envelope = envelope.is_envelope();
    let (impl_generics, type_generics, where_clause) = input.generics.split_for_impl();
    Ok(quote! {
        impl #impl_generics ::boundary_core::PortableFault for #name #type_generics #where_clause {
            const ENVELOPE: bool = #is_envelope;

            fn code(&self) -> &'static str {
                match self {
                    #(#arms),*
                }
            }
        }
    })
}

#[derive(Default)]
struct SerdeContainer {
    tag: Option<String>,
    content: Option<String>,
    rename_all: bool,
}

impl SerdeContainer {
    fn is_envelope(&self) -> bool {
        self.tag.as_deref() == Some("code") && self.content.as_deref() == Some("details")
    }
}

/// Skips the value of a Serde meta item this derive does not interpret.
fn skip_meta(meta: &syn::meta::ParseNestedMeta<'_>) -> syn::Result<()> {
    if meta.input.peek(Token![=]) {
        meta.value()?.parse::<syn::Expr>()?;
    } else if meta.input.peek(syn::token::Paren) {
        let content;
        syn::parenthesized!(content in meta.input);
        content.parse::<proc_macro2::TokenStream>()?;
    }
    Ok(())
}

fn serde_container(input: &DeriveInput) -> syn::Result<SerdeContainer> {
    let mut container = SerdeContainer::default();
    for attribute in input
        .attrs
        .iter()
        .filter(|attribute| attribute.path().is_ident("serde"))
    {
        attribute.parse_nested_meta(|meta| {
            if meta.path.is_ident("tag") {
                container.tag = Some(meta.value()?.parse::<LitStr>()?.value());
            } else if meta.path.is_ident("content") {
                container.content = Some(meta.value()?.parse::<LitStr>()?.value());
            } else {
                container.rename_all |= meta.path.is_ident("rename_all");
                skip_meta(&meta)?;
            }
            Ok(())
        })?;
    }
    Ok(container)
}

fn serde_variant_name(variant: &syn::Variant) -> syn::Result<Option<String>> {
    let mut name = None;
    for attribute in variant
        .attrs
        .iter()
        .filter(|attribute| attribute.path().is_ident("serde"))
    {
        attribute.parse_nested_meta(|meta| {
            if meta.path.is_ident("rename") {
                if !meta.input.peek(Token![=]) {
                    return Err(meta.error(
                        "BOUNDARY_FAULT_SERDE_CODE: use `rename = \"<code>\"` without separate serialize/deserialize names",
                    ));
                }
                name = Some(meta.value()?.parse::<LitStr>()?.value());
                Ok(())
            } else {
                skip_meta(&meta)
            }
        })?;
    }
    Ok(name)
}

fn is_token(code: &str) -> bool {
    let mut bytes = code.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && code.len() <= 64
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}
