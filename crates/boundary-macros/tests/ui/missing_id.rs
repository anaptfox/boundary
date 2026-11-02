use boundary_macros::Interaction;

#[derive(Interaction)]
#[interaction(output = String)]
struct MissingId {
    value: String,
}

fn main() {}
